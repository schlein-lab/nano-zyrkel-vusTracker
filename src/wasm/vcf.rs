//! VCF parser + ClinVar matcher — runs entirely in the browser.
//! No data leaves the WASM sandbox. DSGVO by design.

use std::collections::HashMap;
use crate::clinvar::{ClinVarVariant, Classification};

#[derive(Debug, Clone, serde::Serialize)]
pub struct VcfVariant {
    pub chrom: String,
    pub pos: u64,
    pub ref_allele: String,
    pub alt_allele: String,
}

#[derive(Debug, serde::Serialize)]
pub struct MatchResult {
    pub total_vcf_variants: usize,
    pub matched_count: usize,
    pub unmatched_count: usize,
    pub pathogenic: Vec<MatchedVariant>,
    pub vus: Vec<MatchedVariant>,
    pub benign: Vec<MatchedVariant>,
}

#[derive(Debug, serde::Serialize)]
pub struct MatchedVariant {
    pub chrom: String,
    pub pos: u64,
    pub gene: String,
    pub hgvs: String,
    pub classification: String,
    pub condition: String,
}

/// Parse VCF 4.x format. Handles chr prefix, multi-allelic, standard fields.
pub fn parse_vcf(content: &str) -> Vec<VcfVariant> {
    content.lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 5 { return None; }
            Some(VcfVariant {
                chrom: f[0].replace("chr", "").to_string(),
                pos: f[1].parse().ok()?,
                ref_allele: f[3].to_string(),
                alt_allele: f[4].split(',').next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Match VCF variants against ClinVar data using position index.
pub fn match_against_clinvar(
    vcf: &[VcfVariant],
    clinvar: &[ClinVarVariant],
    position_index: &HashMap<String, usize>,
) -> MatchResult {
    let mut pathogenic = Vec::new();
    let mut vus = Vec::new();
    let mut benign = Vec::new();
    let mut matched_count = 0;

    for v in vcf {
        let key = format!("{}:{}:{}>{}", v.chrom, v.pos, v.ref_allele, v.alt_allele);
        if let Some(&idx) = position_index.get(&key) {
            let cv = &clinvar[idx];
            let m = MatchedVariant {
                chrom: v.chrom.clone(),
                pos: v.pos,
                gene: cv.gene.clone(),
                hgvs: cv.hgvs.clone(),
                classification: cv.classification.to_string(),
                condition: cv.condition.clone(),
            };
            match cv.classification {
                Classification::Pathogenic | Classification::LikelyPathogenic => pathogenic.push(m),
                Classification::Vus => vus.push(m),
                Classification::Benign | Classification::LikelyBenign => benign.push(m),
                _ => {}
            }
            matched_count += 1;
        }
    }

    MatchResult {
        total_vcf_variants: vcf.len(),
        matched_count,
        unmatched_count: vcf.len() - matched_count,
        pathogenic,
        vus,
        benign,
    }
}
