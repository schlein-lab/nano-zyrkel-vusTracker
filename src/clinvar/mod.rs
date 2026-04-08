//! ClinVar VUS Reclassification + Submission Tracker.
//!
//! Architecture:
//!   fetcher.rs  — Query NCBI E-utilities API for new ClinVar submissions
//!   parser.rs   — Parse API responses → ClinVarVariant structs
//!   tracker.rs  — Compare against known variants, detect reclassifications
//!   stats.rs    — Compute: VUS half-life, lab concordance, gene discord, trends
//!   reporter.rs — Generate embeddable HTML widget with inline SVG sparklines
//!   state.rs    — Persistent JSONL storage (variants, reclassifications, daily stats)

#[cfg(not(target_arch = "wasm32"))]
pub mod backfill;
#[cfg(not(target_arch = "wasm32"))]
pub mod fetcher;
pub mod parser;
pub mod tracker;
pub mod stats;
#[cfg(not(target_arch = "wasm32"))]
pub mod reporter;
pub mod state;

#[cfg(not(target_arch = "wasm32"))]
use anyhow::{Context, Result};

/// Classification enum for variant interpretations.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Classification {
    Pathogenic,
    LikelyPathogenic,
    Vus,
    LikelyBenign,
    Benign,
    ConflictingInterpretations,
    Other(String),
}

impl std::fmt::Display for Classification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pathogenic => write!(f, "pathogenic"),
            Self::LikelyPathogenic => write!(f, "likely pathogenic"),
            Self::Vus => write!(f, "VUS"),
            Self::LikelyBenign => write!(f, "likely benign"),
            Self::Benign => write!(f, "benign"),
            Self::ConflictingInterpretations => write!(f, "conflicting"),
            Self::Other(s) => write!(f, "{}", s),
        }
    }
}

impl Classification {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "pathogenic" => Self::Pathogenic,
            "likely pathogenic" => Self::LikelyPathogenic,
            "uncertain significance" | "vus" => Self::Vus,
            "likely benign" => Self::LikelyBenign,
            "benign" => Self::Benign,
            "conflicting interpretations of pathogenicity"
            | "conflicting classifications of pathogenicity" => Self::ConflictingInterpretations,
            other => Self::Other(other.to_string()),
        }
    }

    pub fn badge_class(&self) -> &str {
        match self {
            Self::Pathogenic | Self::LikelyPathogenic => "badge-path",
            Self::Vus => "badge-vus",
            Self::Benign | Self::LikelyBenign => "badge-benign",
            _ => "",
        }
    }

    pub fn short(&self) -> &str {
        match self {
            Self::Pathogenic => "path.",
            Self::LikelyPathogenic => "l.path.",
            Self::Vus => "VUS",
            Self::LikelyBenign => "l.ben.",
            Self::Benign => "benign",
            Self::ConflictingInterpretations => "confl.",
            Self::Other(_) => "other",
        }
    }
}

/// A single ClinVar variant entry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClinVarVariant {
    pub variation_id: String,
    pub gene: String,
    pub hgvs: String,
    pub classification: Classification,
    pub review_status: String,
    pub submitter: String,
    pub last_evaluated: String,
    pub condition: String,
    pub first_seen: String,
}

/// A detected reclassification event.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReclassificationEvent {
    pub variation_id: String,
    pub gene: String,
    pub hgvs: String,
    pub old: Classification,
    pub new: Classification,
    pub detected_at: String,
    pub submitter: String,
}

/// Daily statistics snapshot.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DailyStats {
    pub date: String,
    pub new_submissions: u32,
    pub reclassifications: u32,
    pub vus_to_pathogenic: u32,
    pub vus_to_benign: u32,
    pub pathogenic_to_vus: u32,
    pub top_genes: Vec<(String, u32)>,
}

/// Aggregate statistics (computed across all time).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct AggregateStats {
    pub total_variants: u64,
    pub total_reclassifications: u64,
    pub agent_start_date: String,
    pub concordance: f64,
    pub vus_half_life_by_gene: Vec<(String, f64)>,
    pub gene_discord: Vec<(String, f64, u32)>,
    pub monthly_trend: (i32, String),
    pub new_vus_today: u32,
    pub vus_to_path_30d: u32,
}

// The run_clinvar() orchestrator lives in main.rs (binary-only).
// This keeps the lib clean for WASM compilation.
