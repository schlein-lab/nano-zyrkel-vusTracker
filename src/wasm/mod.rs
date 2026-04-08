//! WASM exports — exposes ClinVar analysis to JavaScript.
//! All heavy computation runs in the browser via WebAssembly.

use wasm_bindgen::prelude::*;
use std::collections::HashMap;
use crate::clinvar::{ClinVarVariant, ReclassificationEvent, Classification, AggregateStats};
use crate::clinvar::stats;

pub mod vcf;
pub mod panels;

/// Main entry point for the WASM module.
/// Holds all loaded variants + indices for fast lookups.
#[wasm_bindgen]
pub struct VusTracker {
    variants: Vec<ClinVarVariant>,
    reclassifications: Vec<ReclassificationEvent>,
    // Indices (built once, used for all queries)
    gene_index: HashMap<String, Vec<usize>>,
    class_index: HashMap<String, Vec<usize>>,
    id_index: HashMap<String, usize>,
    position_index: HashMap<String, usize>,
}

#[wasm_bindgen]
impl VusTracker {
    /// Create a new empty tracker.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            variants: Vec::new(),
            reclassifications: Vec::new(),
            gene_index: HashMap::new(),
            class_index: HashMap::new(),
            id_index: HashMap::new(),
            position_index: HashMap::new(),
        }
    }

    /// Load variants from JSONL string. Can be called multiple times
    /// to append data (e.g., load gene-specific files on demand).
    /// Deduplicates by variation_id and rebuilds all indices.
    pub fn load_variants(&mut self, jsonl: &str) {
        let new: Vec<ClinVarVariant> = jsonl.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();

        // Deduplicate: keep existing, add only new variation_ids
        let existing_ids: std::collections::HashSet<String> = self.variants.iter()
            .map(|v| v.variation_id.clone())
            .collect();
        let mut added = 0;
        for v in new {
            if !existing_ids.contains(&v.variation_id) {
                self.variants.push(v);
                added += 1;
            }
        }

        self.build_indices();
    }

    /// Load reclassification events from JSONL string.
    pub fn load_reclassifications(&mut self, jsonl: &str) {
        self.reclassifications = jsonl.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
    }

    /// Total number of loaded variants.
    pub fn variant_count(&self) -> usize {
        self.variants.len()
    }

    /// Total number of classification change events.
    pub fn reclass_count(&self) -> usize {
        self.reclassifications.len()
    }

    /// "What changed since my report?" — find classification changes for a gene since a date.
    /// Input: gene name, ISO date (YYYY-MM-DD). Returns JSON array of changes.
    pub fn changes_since(&self, gene: &str, since_date: &str) -> String {
        let upper = gene.to_uppercase();
        let results: Vec<&ReclassificationEvent> = self.reclassifications.iter()
            .filter(|r| {
                (upper.is_empty() || r.gene.to_uppercase() == upper)
                && r.detected_at.as_str() >= since_date
            })
            .collect();

        serde_json::json!({
            "gene": gene,
            "since": since_date,
            "total": results.len(),
            "changes": results.iter().take(50).collect::<Vec<_>>(),
        }).to_string()
    }

    /// Search by gene name. Returns JSON with total count + sample (up to 200).
    pub fn search_gene(&self, gene: &str) -> String {
        let upper = gene.to_uppercase();
        let indices = self.gene_index.get(&upper);
        match indices {
            Some(idxs) => {
                let sample: Vec<&ClinVarVariant> = idxs.iter().take(200).map(|&i| &self.variants[i]).collect();
                serde_json::json!({
                    "total": idxs.len(),
                    "sample": sample,
                }).to_string()
            }
            None => serde_json::json!({"total": 0, "sample": []}).to_string(),
        }
    }

    /// Get classification breakdown for a gene. Returns JSON with counts per class.
    pub fn gene_stats(&self, gene: &str) -> String {
        let upper = gene.to_uppercase();
        let indices = match self.gene_index.get(&upper) {
            Some(idxs) => idxs,
            None => return serde_json::json!({"total": 0}).to_string(),
        };

        let mut path = 0u32;
        let mut lpath = 0u32;
        let mut vus = 0u32;
        let mut lben = 0u32;
        let mut ben = 0u32;
        let mut confl = 0u32;
        let mut other = 0u32;

        for &i in indices {
            match &self.variants[i].classification {
                Classification::Pathogenic => path += 1,
                Classification::LikelyPathogenic => lpath += 1,
                Classification::Vus => vus += 1,
                Classification::LikelyBenign => lben += 1,
                Classification::Benign => ben += 1,
                Classification::ConflictingInterpretations => confl += 1,
                Classification::Other(_) => other += 1,
            }
        }

        serde_json::json!({
            "total": indices.len(),
            "pathogenic": path,
            "likely_pathogenic": lpath,
            "vus": vus,
            "likely_benign": lben,
            "benign": ben,
            "conflicting": confl,
            "other": other,
        }).to_string()
    }

    /// Search by HGVS, gene, variant name, or any substring. Returns JSON array.
    /// Searches: c.1234, p.Arg123, NM_000527, gene names, conditions.
    pub fn search_variant(&self, query: &str) -> String {
        let q = query.to_lowercase();
        let results: Vec<&ClinVarVariant> = self.variants.iter()
            .filter(|v| {
                v.hgvs.to_lowercase().contains(&q)
                || v.gene.to_lowercase().contains(&q)
                || v.condition.to_lowercase().contains(&q)
                || v.variation_id.contains(&q)
            })
            .take(100)
            .collect();
        serde_json::to_string(&results).unwrap_or_else(|_| "[]".into())
    }

    /// Filter by classification. Returns JSON object with total count + sample.
    pub fn filter_classification(&self, class: &str) -> String {
        let indices = self.class_index.get(class);
        match indices {
            Some(idxs) => {
                let sample: Vec<&ClinVarVariant> = idxs.iter().take(50).map(|&i| &self.variants[i]).collect();
                serde_json::json!({
                    "total": idxs.len(),
                    "sample": sample,
                }).to_string()
            }
            None => serde_json::json!({"total": 0, "sample": []}).to_string(),
        }
    }

    /// Compute all aggregate stats. Returns JSON.
    pub fn compute_stats(&self) -> String {
        let state = crate::clinvar::state::ClinVarState {
            variants: self.variants.clone(),
            reclassifications: self.reclassifications.clone(),
            daily_stats: Vec::new(),
            last_fetch_date: String::new(),
        };
        let agg = stats::compute_aggregates(&state);
        serde_json::to_string(&agg).unwrap_or_else(|_| "{}".into())
    }

    /// Filter by date range and recompute stats. Returns JSON.
    pub fn set_time_range(&self, preset: &str) -> String {
        let today = chrono::Utc::now().date_naive();
        let from = match preset {
            "all" => chrono::NaiveDate::from_ymd_opt(2000, 1, 1).unwrap(),
            "10y" => today - chrono::Duration::days(3650),
            "5y" => today - chrono::Duration::days(1825),
            "1y" => today - chrono::Duration::days(365),
            "1m" => today - chrono::Duration::days(30),
            "7d" => today - chrono::Duration::days(7),
            _ => today - chrono::Duration::days(7),
        };
        let from_str = from.to_string();

        let filtered: Vec<ClinVarVariant> = self.variants.iter()
            .filter(|v| v.last_evaluated >= from_str || v.first_seen >= from_str)
            .cloned()
            .collect();

        let filtered_reclass: Vec<ReclassificationEvent> = self.reclassifications.iter()
            .filter(|r| r.detected_at >= from_str)
            .cloned()
            .collect();

        let state = crate::clinvar::state::ClinVarState {
            variants: filtered,
            reclassifications: filtered_reclass,
            daily_stats: Vec::new(),
            last_fetch_date: String::new(),
        };
        let agg = stats::compute_aggregates(&state);
        serde_json::to_string(&agg).unwrap_or_else(|_| "{}".into())
    }

    /// Get variants for a gene panel (comma-separated gene list). Returns JSON.
    pub fn panel(&self, genes_csv: &str) -> String {
        let genes: Vec<String> = genes_csv.split(',')
            .map(|g| g.trim().to_uppercase())
            .collect();
        let results: Vec<&ClinVarVariant> = genes.iter()
            .flat_map(|g| {
                self.gene_index.get(g)
                    .map(|idxs| idxs.iter().map(|&i| &self.variants[i]).collect::<Vec<_>>())
                    .unwrap_or_default()
            })
            .take(500)
            .collect();
        serde_json::to_string(&results).unwrap_or_else(|_| "[]".into())
    }

    /// Get predefined gene panels. Returns JSON array of {name, genes}.
    pub fn predefined_panels(&self) -> String {
        serde_json::to_string(&panels::predefined_panels()).unwrap_or_else(|_| "[]".into())
    }

    /// Parse a VCF string and match against loaded ClinVar data. Returns JSON.
    /// ALL processing happens locally — no network calls.
    pub fn match_vcf(&self, vcf_content: &str) -> String {
        let vcf_variants = vcf::parse_vcf(vcf_content);
        let result = vcf::match_against_clinvar(&vcf_variants, &self.variants, &self.position_index);
        serde_json::to_string(&result).unwrap_or_else(|_| "{}".into())
    }

    /// VUS survival curve for a gene (Kaplan-Meier). Returns JSON array of [days, survival_prob].
    pub fn vus_survival_curve(&self, gene: &str) -> String {
        let upper = gene.to_uppercase();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut events: Vec<(f64, bool)> = Vec::new();

        let gene_variants: Vec<&ClinVarVariant> = self.gene_index.get(&upper)
            .map(|idxs| idxs.iter().map(|&i| &self.variants[i]).collect())
            .unwrap_or_default();

        for v in &gene_variants {
            if let Some(reclass) = self.reclassifications.iter()
                .find(|r| r.variation_id == v.variation_id && matches!(r.old, Classification::Vus))
            {
                if let (Ok(f), Ok(d)) = (
                    chrono::NaiveDate::parse_from_str(&v.first_seen, "%Y-%m-%d"),
                    chrono::NaiveDate::parse_from_str(&reclass.detected_at, "%Y-%m-%d"),
                ) {
                    events.push(((d - f).num_days().max(1) as f64, true));
                }
            } else if matches!(v.classification, Classification::Vus) {
                if let Ok(f) = chrono::NaiveDate::parse_from_str(&v.first_seen, "%Y-%m-%d") {
                    if let Ok(t) = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d") {
                        events.push(((t - f).num_days().max(1) as f64, false));
                    }
                }
            }
        }

        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let mut curve = Vec::new();
        let mut at_risk = events.len() as f64;
        let mut survival = 1.0;

        for (days, is_event) in &events {
            if *is_event && at_risk > 0.0 {
                survival *= (at_risk - 1.0) / at_risk;
                curve.push((*days, survival));
            }
            at_risk -= 1.0;
        }

        serde_json::to_string(&curve).unwrap_or_else(|_| "[]".into())
    }

    /// Compute stats for a gene range (distributed computing).
    /// Returns JSON with input_hash + output_hash for verification.
    pub fn compute_range(&self, start: usize, end: usize) -> String {
        use sha2::{Sha256, Digest};

        let gene_names: Vec<&String> = self.gene_index.keys().collect();
        let s = start.min(gene_names.len());
        let e = end.min(gene_names.len());
        if s >= e { return "{}".into(); }

        let assigned = &gene_names[s..e];

        // Hash input
        let mut hasher = Sha256::new();
        for gene in assigned {
            if let Some(idxs) = self.gene_index.get(*gene) {
                for &i in idxs {
                    hasher.update(self.variants[i].variation_id.as_bytes());
                    hasher.update(self.variants[i].classification.short().as_bytes());
                }
            }
        }
        let input_hash = format!("{:x}", hasher.finalize());

        // Compute
        let empty = vec![];
        let filtered: Vec<&ClinVarVariant> = assigned.iter()
            .flat_map(|g| self.gene_index.get(*g).unwrap_or(&empty))
            .map(|&i| &self.variants[i])
            .collect();

        let vus_count = filtered.iter().filter(|v| matches!(v.classification, Classification::Vus)).count();
        let path_count = filtered.iter().filter(|v| matches!(v.classification, Classification::Pathogenic)).count();

        let result = serde_json::json!({
            "input_hash": input_hash,
            "gene_range": [s, e],
            "genes_computed": assigned.len(),
            "variants": filtered.len(),
            "vus": vus_count,
            "pathogenic": path_count,
        });

        let output_str = serde_json::to_string(&result).unwrap();
        let output_hash = format!("{:x}", sha2::Sha256::digest(output_str.as_bytes()));

        serde_json::json!({
            "input_hash": input_hash,
            "output_hash": output_hash,
            "result": result,
        }).to_string()
    }
}

impl VusTracker {
    /// Build all lookup indices. Called once after loading data.
    fn build_indices(&mut self) {
        self.gene_index.clear();
        self.class_index.clear();
        self.id_index.clear();
        self.position_index.clear();

        for (i, v) in self.variants.iter().enumerate() {
            self.gene_index.entry(v.gene.to_uppercase()).or_default().push(i);
            self.class_index.entry(v.classification.short().to_string()).or_default().push(i);
            self.id_index.insert(v.variation_id.clone(), i);
            // Position index for VCF matching (if we have genomic coords)
        }
    }
}
