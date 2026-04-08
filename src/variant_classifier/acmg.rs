//! ACMG criteria evaluation and 5-tier classification.
//!
//! Evaluates applicable criteria from myvariant.info data:
//! - Population frequency: BA1, BS1, PM2
//! - ClinVar: PP5, BP6
//! - In-silico predictors: PP3, BP4
//!
//! Returns structured result with met criteria, evidence, and final class.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::myvariant;

/// Full ACMG evaluation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcmgResult {
    pub classification: Classification,
    pub criteria_met: Vec<Criterion>,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Criterion {
    pub code: String,
    pub description: String,
    pub strength: CriterionStrength,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CriterionStrength {
    VeryStrong,
    Strong,
    Moderate,
    Supporting,
    #[serde(rename = "stand_alone")]
    StandAlone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub gnomad_af: Option<f64>,
    pub clinvar_significance: Option<String>,
    pub predictors: Vec<PredictorScore>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictorScore {
    pub name: String,
    pub score: f64,
    pub threshold: String,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Pathogenic,
    Benign,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Classification {
    Pathogenic,
    LikelyPathogenic,
    #[serde(rename = "VUS")]
    Vus,
    LikelyBenign,
    Benign,
}

impl std::fmt::Display for Classification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pathogenic => write!(f, "Pathogenic"),
            Self::LikelyPathogenic => write!(f, "Likely pathogenic"),
            Self::Vus => write!(f, "VUS (Uncertain Significance)"),
            Self::LikelyBenign => write!(f, "Likely benign"),
            Self::Benign => write!(f, "Benign"),
        }
    }
}

impl Classification {
    pub fn color(&self) -> &'static str {
        match self {
            Self::Pathogenic => "#d32f2f",
            Self::LikelyPathogenic => "#e64a19",
            Self::Vus => "#f9a825",
            Self::LikelyBenign => "#388e3c",
            Self::Benign => "#1b5e20",
        }
    }
}

// -- Criterion catalog --

fn criterion(code: &str, desc: &str, strength: CriterionStrength) -> Criterion {
    Criterion { code: code.into(), description: desc.into(), strength }
}

/// Evaluate ACMG criteria from myvariant.info annotation data.
pub fn evaluate(mv_data: &Value, af_threshold: f64) -> AcmgResult {
    let mut criteria = Vec::new();
    let mut predictors = Vec::new();

    // --- Population frequency ---
    let af = myvariant::extract_gnomad_af(mv_data);
    if let Some(af_val) = af {
        if af_val > 0.05 {
            criteria.push(criterion("BA1", "Allelfrequenz >5% in gnomAD", CriterionStrength::StandAlone));
        } else if af_val > af_threshold {
            criteria.push(criterion("BS1", "Allelfrequenz hoeher als fuer Erkrankung erwartet", CriterionStrength::Strong));
        } else if af_val < 0.0001 {
            criteria.push(criterion("PM2", "Absent oder extrem selten in Populationsdatenbanken", CriterionStrength::Moderate));
        }
    } else {
        criteria.push(criterion("PM2", "Absent oder extrem selten in Populationsdatenbanken", CriterionStrength::Moderate));
    }

    // --- ClinVar ---
    let clin_sig = myvariant::extract_clinvar_significance(mv_data);
    if let Some(ref sig) = clin_sig {
        let sig_lower = sig.to_lowercase();
        if sig_lower.contains("pathogenic") && !sig_lower.contains("uncertain") {
            criteria.push(criterion("PP5", "Zuverlaessige Quelle meldet pathogen (ClinVar)", CriterionStrength::Supporting));
        } else if sig_lower.contains("benign") {
            criteria.push(criterion("BP6", "Zuverlaessige Quelle meldet benigne (ClinVar)", CriterionStrength::Supporting));
        }
    }

    // --- In-silico predictors ---
    let mut path_count = 0u32;
    let mut ben_count = 0u32;

    let dbnsfp = &mv_data["dbnsfp"];

    // CADD
    if let Some(phred) = myvariant::extract_score(mv_data, &["cadd", "phred"]) {
        let v = if phred >= 20.0 { Verdict::Pathogenic } else { Verdict::Benign };
        predictors.push(PredictorScore { name: "CADD".into(), score: phred, threshold: ">= 20".into(), verdict: v });
        if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
    }

    // REVEL
    if let Some(score) = myvariant::extract_score(dbnsfp, &["revel", "score"]) {
        let v = if score >= 0.5 { Verdict::Pathogenic } else { Verdict::Benign };
        predictors.push(PredictorScore { name: "REVEL".into(), score, threshold: ">= 0.5".into(), verdict: v });
        if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
    }

    // SpliceAI (max delta score)
    let splice_keys = ["ds_ag", "ds_al", "ds_dg", "ds_dl"];
    let splice_max = splice_keys.iter()
        .filter_map(|k| myvariant::extract_score(dbnsfp, &["spliceai", k]))
        .reduce(f64::max);
    if let Some(score) = splice_max {
        if score > 0.0 {
            let v = if score >= 0.2 { Verdict::Pathogenic } else { Verdict::Benign };
            predictors.push(PredictorScore { name: "SpliceAI".into(), score, threshold: ">= 0.2".into(), verdict: v });
            if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
        }
    }

    // AlphaMissense
    if let Some(score) = myvariant::extract_score(dbnsfp, &["alphamissense", "score"]) {
        let v = if score >= 0.564 { Verdict::Pathogenic } else { Verdict::Benign };
        predictors.push(PredictorScore { name: "AlphaMissense".into(), score, threshold: ">= 0.564".into(), verdict: v });
        if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
    }

    // PolyPhen2 HDIV
    if let Some(score) = myvariant::extract_score(dbnsfp, &["polyphen2", "hdiv", "score"]) {
        let v = if score >= 0.453 { Verdict::Pathogenic } else { Verdict::Benign };
        predictors.push(PredictorScore { name: "PolyPhen2".into(), score, threshold: ">= 0.453".into(), verdict: v });
        if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
    }

    // SIFT (inverted: lower = more damaging)
    if let Some(score) = myvariant::extract_score(dbnsfp, &["sift", "score"]) {
        let v = if score < 0.05 { Verdict::Pathogenic } else { Verdict::Benign };
        predictors.push(PredictorScore { name: "SIFT".into(), score, threshold: "< 0.05".into(), verdict: v });
        if v == Verdict::Pathogenic { path_count += 1; } else { ben_count += 1; }
    }

    if path_count >= 3 {
        criteria.push(criterion("PP3", "Multiple in-silico Tools sagen schaedigend voraus", CriterionStrength::Supporting));
    } else if ben_count >= 3 {
        criteria.push(criterion("BP4", "Multiple in-silico Tools sagen benigne voraus", CriterionStrength::Supporting));
    }

    // --- Classify ---
    let classification = classify(&criteria);

    AcmgResult {
        classification,
        criteria_met: criteria,
        evidence: Evidence {
            gnomad_af: af,
            clinvar_significance: clin_sig,
            predictors,
        },
    }
}

fn classify(criteria: &[Criterion]) -> Classification {
    let codes: std::collections::HashSet<&str> = criteria.iter().map(|c| c.code.as_str()).collect();

    // Stand-alone benign
    if codes.contains("BA1") {
        return Classification::Benign;
    }

    let path_strong = ["PVS1", "PS1", "PS3"].iter().filter(|c| codes.contains(**c)).count();
    let path_moderate = ["PM1", "PM2", "PM5"].iter().filter(|c| codes.contains(**c)).count();
    let path_supporting = ["PP3", "PP5"].iter().filter(|c| codes.contains(**c)).count();

    let ben_strong = ["BS1", "BS2"].iter().filter(|c| codes.contains(**c)).count();
    let ben_supporting = ["BP1", "BP4", "BP6"].iter().filter(|c| codes.contains(**c)).count();

    // Pathogenic
    if path_strong >= 2 { return Classification::Pathogenic; }
    if path_strong >= 1 && path_moderate >= 1 { return Classification::Pathogenic; }
    if path_strong >= 1 && path_supporting >= 2 { return Classification::LikelyPathogenic; }

    // Likely pathogenic
    if path_moderate >= 2 && path_supporting >= 1 { return Classification::LikelyPathogenic; }
    if path_moderate >= 1 && path_supporting >= 2 { return Classification::LikelyPathogenic; }

    // Benign
    if ben_strong >= 2 { return Classification::Benign; }
    if ben_strong >= 1 && ben_supporting >= 1 { return Classification::LikelyBenign; }
    if ben_supporting >= 2 { return Classification::LikelyBenign; }

    Classification::Vus
}
