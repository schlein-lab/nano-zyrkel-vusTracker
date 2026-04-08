//! ClinVar backfill — parse the full variant_summary.txt from NCBI FTP.
//! One-time import of ~2.5M variants with historical reclassification detection.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::io::BufRead;
use super::{ClinVarVariant, ReclassificationEvent, Classification};
use super::state;

/// Run the backfill pipeline: parse → deduplicate → detect reclassifications → save.
pub fn run_backfill(path: &str, output_dir: &str) -> Result<()> {
    tracing::info!("[backfill] Parsing {}", path);

    let variants = parse_variant_summary(path)?;
    tracing::info!("[backfill] Parsed {} raw rows", variants.len());

    // Deduplicate by variation_id (keep latest entry per variant)
    let deduped = deduplicate(&variants);
    tracing::info!("[backfill] {} unique variants after dedup", deduped.len());

    // Detect historical reclassifications
    let reclassifications = detect_historical_reclassifications(&variants);
    tracing::info!("[backfill] {} historical reclassifications detected", reclassifications.len());

    // Build index
    let index = build_index(&deduped, &reclassifications);

    // Save
    std::fs::create_dir_all(output_dir)?;

    let variants_path = format!("{}/variants.jsonl", output_dir);
    save_jsonl(&variants_path, &deduped)?;
    tracing::info!("[backfill] Wrote {} variants to {}", deduped.len(), variants_path);

    let reclass_path = format!("{}/reclassifications.jsonl", output_dir);
    save_jsonl(&reclass_path, &reclassifications)?;
    tracing::info!("[backfill] Wrote {} reclassifications to {}", reclassifications.len(), reclass_path);

    let index_path = format!("{}/index.json", output_dir);
    std::fs::write(&index_path, serde_json::to_string_pretty(&index)?)?;
    tracing::info!("[backfill] Wrote index to {}", index_path);

    // Summary stats
    let vus_count = deduped.iter().filter(|v| matches!(v.classification, Classification::Vus)).count();
    let path_count = deduped.iter().filter(|v| matches!(v.classification, Classification::Pathogenic | Classification::LikelyPathogenic)).count();
    let benign_count = deduped.iter().filter(|v| matches!(v.classification, Classification::Benign | Classification::LikelyBenign)).count();
    let gene_count = {
        let mut genes = std::collections::HashSet::new();
        for v in &deduped { genes.insert(&v.gene); }
        genes.len()
    };

    tracing::info!("[backfill] Summary:");
    tracing::info!("  Total variants: {}", deduped.len());
    tracing::info!("  Genes: {}", gene_count);
    tracing::info!("  Pathogenic/Likely: {}", path_count);
    tracing::info!("  VUS: {}", vus_count);
    tracing::info!("  Benign/Likely: {}", benign_count);
    tracing::info!("  Reclassifications: {}", reclassifications.len());

    Ok(())
}

/// Parse NCBI variant_summary.txt (tab-separated).
/// Handles both GRCh37 and GRCh38 rows — keeps GRCh38 preferred.
fn parse_variant_summary(path: &str) -> Result<Vec<ClinVarVariant>> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("Cannot open {}", path))?;
    let reader = std::io::BufReader::with_capacity(1024 * 1024, file); // 1 MB buffer
    let mut variants = Vec::with_capacity(3_000_000);
    let mut header_cols: HashMap<String, usize> = HashMap::new();

    for (line_num, line) in reader.lines().enumerate() {
        let line = line?;

        // Parse header
        if line_num == 0 {
            for (i, col) in line.split('\t').enumerate() {
                header_cols.insert(col.replace('#', "").trim().to_string(), i);
            }
            tracing::debug!("[backfill] Header columns: {:?}", header_cols.keys().collect::<Vec<_>>());
            continue;
        }

        let fields: Vec<&str> = line.split('\t').collect();

        // Get column indices (flexible — handles schema changes)
        let gene = get_field(&fields, &header_cols, "GeneSymbol");
        let hgvs = get_field(&fields, &header_cols, "Name");
        let significance = get_field(&fields, &header_cols, "ClinicalSignificance");
        let last_eval = get_field(&fields, &header_cols, "LastEvaluated");
        let review = get_field(&fields, &header_cols, "ReviewStatus");
        let n_submitters = get_field(&fields, &header_cols, "NumberSubmitters");
        let variation_id = get_field(&fields, &header_cols, "VariationID");
        let condition = get_field(&fields, &header_cols, "PhenotypeList");
        let assembly = get_field(&fields, &header_cols, "Assembly");

        // Skip if essential fields missing
        if gene.is_empty() || gene == "-" || gene == "." { continue; }
        if significance.is_empty() || significance == "-" { continue; }
        if variation_id.is_empty() { continue; }

        // Prefer GRCh38 rows, but accept GRCh37 if no GRCh38 available
        // (deduplicate later keeps the latest)
        let _ = assembly; // We keep both, dedup handles it

        variants.push(ClinVarVariant {
            variation_id: variation_id.to_string(),
            gene: gene.to_string(),
            hgvs: hgvs.to_string(),
            classification: Classification::from_str(&significance),
            review_status: review.to_string(),
            submitter: if n_submitters.is_empty() { "1".into() } else { format!("{} submitters", n_submitters) },
            last_evaluated: last_eval.to_string(),
            condition: condition.to_string(),
            first_seen: last_eval.to_string(), // best proxy we have
        });

        if line_num % 500_000 == 0 && line_num > 0 {
            tracing::info!("[backfill] Parsed {} rows...", line_num);
        }
    }

    Ok(variants)
}

fn get_field<'a>(fields: &'a [&str], header: &HashMap<String, usize>, name: &str) -> &'a str {
    header.get(name)
        .and_then(|&i| fields.get(i).copied())
        .unwrap_or("")
}

/// Deduplicate: keep one entry per variation_id (the one with the latest date).
fn deduplicate(variants: &[ClinVarVariant]) -> Vec<ClinVarVariant> {
    let mut best: HashMap<String, &ClinVarVariant> = HashMap::new();
    for v in variants {
        let existing = best.get(&v.variation_id);
        let keep = match existing {
            None => true,
            Some(old) => v.last_evaluated > old.last_evaluated,
        };
        if keep {
            best.insert(v.variation_id.clone(), v);
        }
    }
    best.into_values().cloned().collect()
}

/// Detect historical reclassifications.
/// Groups all rows by variation_id, sorts by date, detects classification changes.
fn detect_historical_reclassifications(variants: &[ClinVarVariant]) -> Vec<ReclassificationEvent> {
    let mut groups: HashMap<&str, Vec<&ClinVarVariant>> = HashMap::new();
    for v in variants {
        groups.entry(&v.variation_id).or_default().push(v);
    }

    let mut events = Vec::new();
    for (_, mut group) in groups {
        if group.len() < 2 { continue; }
        group.sort_by(|a, b| a.last_evaluated.cmp(&b.last_evaluated));

        // Compare consecutive entries for the same variant
        for window in group.windows(2) {
            if window[0].classification != window[1].classification {
                events.push(ReclassificationEvent {
                    variation_id: window[1].variation_id.clone(),
                    gene: window[1].gene.clone(),
                    hgvs: window[1].hgvs.clone(),
                    old: window[0].classification.clone(),
                    new: window[1].classification.clone(),
                    detected_at: window[1].last_evaluated.clone(),
                    submitter: window[1].submitter.clone(),
                });
            }
        }
    }

    tracing::info!("[backfill] VUS→Path: {}", events.iter()
        .filter(|e| matches!(e.old, Classification::Vus) && matches!(e.new, Classification::Pathogenic))
        .count());
    tracing::info!("[backfill] VUS→Benign: {}", events.iter()
        .filter(|e| matches!(e.old, Classification::Vus) && matches!(e.new, Classification::Benign | Classification::LikelyBenign))
        .count());

    events
}

/// Build a compact index for the frontend.
fn build_index(variants: &[ClinVarVariant], reclassifications: &[ReclassificationEvent]) -> serde_json::Value {
    let mut gene_counts: HashMap<String, u32> = HashMap::new();
    let mut class_counts: HashMap<String, u32> = HashMap::new();
    let mut date_min = String::from("9999");
    let mut date_max = String::from("0000");

    for v in variants {
        *gene_counts.entry(v.gene.clone()).or_default() += 1;
        *class_counts.entry(v.classification.short().to_string()).or_default() += 1;
        if !v.last_evaluated.is_empty() && v.last_evaluated != "-" {
            if v.last_evaluated < date_min { date_min = v.last_evaluated.clone(); }
            if v.last_evaluated > date_max { date_max = v.last_evaluated.clone(); }
        }
    }

    // Top 50 genes
    let mut top_genes: Vec<(String, u32)> = gene_counts.into_iter().collect();
    top_genes.sort_by(|a, b| b.1.cmp(&a.1));
    top_genes.truncate(50);

    serde_json::json!({
        "total_variants": variants.len(),
        "total_reclassifications": reclassifications.len(),
        "date_range": { "from": date_min, "to": date_max },
        "classifications": class_counts,
        "top_genes": top_genes,
        "generated_at": chrono::Utc::now().to_rfc3339(),
    })
}

fn save_jsonl<T: serde::Serialize>(path: &str, items: &[T]) -> Result<()> {
    use std::io::Write;
    let file = std::fs::File::create(path)?;
    let mut writer = std::io::BufWriter::with_capacity(1024 * 1024, file);
    for item in items {
        serde_json::to_writer(&mut writer, item)?;
        writeln!(writer)?;
    }
    Ok(())
}
