//! ClinVar orchestrator — binary-only (not compiled for WASM).
//! Coordinates: fetch → parse → track → compute → report → notify.

use anyhow::Result;
use crate::config::HatConfig;
use crate::clinvar::*;

pub async fn run_clinvar(config: &HatConfig, dry_run: bool) -> Result<()> {
    let cv = config.clinvar.as_ref()
        .ok_or_else(|| anyhow::anyhow!("clinvar config section missing"))?;

    let staging_dir = format!("{}/{}", config.output_dir, config.id);
    std::fs::create_dir_all(&staging_dir)?;

    let mut cv_state = state::ClinVarState::load(&staging_dir);
    tracing::info!("[clinvar] Loaded state: {} variants, {} reclassifications",
        cv_state.variants.len(), cv_state.reclassifications.len());

    tracing::info!("[clinvar] Fetching new ClinVar submissions...");
    let new_ids = fetcher::fetch_new_variant_ids(cv.max_variants_per_run, cv.request_delay_ms).await?;
    tracing::info!("[clinvar] Found {} new variant IDs", new_ids.len());

    if !new_ids.is_empty() {
        let new_variants = fetcher::fetch_variant_details(&new_ids, cv.request_delay_ms).await?;
        tracing::info!("[clinvar] Fetched details for {} variants", new_variants.len());

        let (added, reclassified) = tracker::process_new_variants(&mut cv_state, &new_variants);
        tracing::info!("[clinvar] Added {}, reclassified {}", added, reclassified.len());

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut gene_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for v in &new_variants { *gene_counts.entry(v.gene.clone()).or_default() += 1; }
        let mut top_genes: Vec<(String, u32)> = gene_counts.into_iter().collect();
        top_genes.sort_by(|a, b| b.1.cmp(&a.1));
        top_genes.truncate(10);

        cv_state.daily_stats.push(DailyStats {
            date: today,
            new_submissions: added as u32,
            reclassifications: reclassified.len() as u32,
            vus_to_pathogenic: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Vus) && matches!(r.new, Classification::Pathogenic)).count() as u32,
            vus_to_benign: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Vus) && matches!(r.new, Classification::Benign | Classification::LikelyBenign)).count() as u32,
            pathogenic_to_vus: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Pathogenic) && matches!(r.new, Classification::Vus)).count() as u32,
            top_genes,
        });

        if !dry_run && !reclassified.is_empty() && cv.notify_reclassifications {
            let msg = format_telegram_digest(&cv_state, &reclassified, added);
            crate::notify::send_telegram(&msg, "en").await.ok();
        }
    }

    let agg = stats::compute_aggregates(&cv_state);

    if cv.generate_html {
        let html = reporter::generate_widget(&agg, &cv_state);
        std::fs::write(format!("{}/index.html", staging_dir), &html)?;
        tracing::info!("[clinvar] Widget written");
    }

    cv_state.save(&staging_dir)?;
    tracing::info!("[clinvar] State saved. {} variants, {} reclassifications.",
        cv_state.variants.len(), cv_state.reclassifications.len());

    Ok(())
}

fn format_telegram_digest(state: &state::ClinVarState, reclass: &[ReclassificationEvent], added: usize) -> String {
    let mut msg = format!("ClinVar Daily\n+{} submissions | {} reclassifications\n", added, reclass.len());
    for r in reclass.iter().take(5) {
        msg.push_str(&format!("{} {}: {} -> {}\n",
            r.gene, &r.hgvs[..r.hgvs.len().min(30)], r.old.short(), r.new.short()));
    }
    if reclass.len() > 5 { msg.push_str(&format!("... and {} more\n", reclass.len() - 5)); }
    msg.push_str(&format!("Total: {} tracked", state.variants.len()));
    msg
}
