//! ClinVar VUS Reclassification + Submission Tracker.
//!
//! Architecture:
//!   fetcher.rs  — Query NCBI E-utilities API for new ClinVar submissions
//!   parser.rs   — Parse API responses → ClinVarVariant structs
//!   tracker.rs  — Compare against known variants, detect reclassifications
//!   stats.rs    — Compute: VUS half-life, lab concordance, gene discord, trends
//!   reporter.rs — Generate embeddable HTML widget with inline SVG sparklines
//!   state.rs    — Persistent JSONL storage (variants, reclassifications, daily stats)

pub mod fetcher;
pub mod parser;
pub mod tracker;
pub mod stats;
pub mod reporter;
pub mod state;

use anyhow::{Context, Result};
use crate::config::HatConfig;

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

/// Run one complete ClinVar tracker cycle.
pub async fn run_clinvar(config: &HatConfig, dry_run: bool) -> Result<()> {
    let cv = config.clinvar.as_ref()
        .ok_or_else(|| anyhow::anyhow!("clinvar config section missing"))?;

    let staging_dir = format!("{}/{}", config.output_dir, config.id);
    std::fs::create_dir_all(&staging_dir)?;

    // 1. Load persistent state
    let mut cv_state = state::ClinVarState::load(&staging_dir);
    tracing::info!("[clinvar] Loaded state: {} variants, {} reclassifications",
        cv_state.variants.len(), cv_state.reclassifications.len());

    // 2. Fetch new variants from NCBI
    tracing::info!("[clinvar] Fetching new ClinVar submissions...");
    let new_ids = fetcher::fetch_new_variant_ids(cv.max_variants_per_run, cv.request_delay_ms).await?;
    tracing::info!("[clinvar] Found {} new variant IDs", new_ids.len());

    if new_ids.is_empty() {
        tracing::info!("[clinvar] No new variants. Generating report from existing data.");
    } else {
        // 3. Fetch details for each variant
        let new_variants = fetcher::fetch_variant_details(&new_ids, cv.request_delay_ms).await?;
        tracing::info!("[clinvar] Fetched details for {} variants", new_variants.len());

        // 4. Track: detect new submissions + reclassifications
        let (added, reclassified) = tracker::process_new_variants(
            &mut cv_state, &new_variants,
        );
        tracing::info!("[clinvar] Added {}, reclassified {}", added, reclassified.len());

        // 5. Record daily stats
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut gene_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for v in &new_variants {
            *gene_counts.entry(v.gene.clone()).or_default() += 1;
        }
        let mut top_genes: Vec<(String, u32)> = gene_counts.into_iter().collect();
        top_genes.sort_by(|a, b| b.1.cmp(&a.1));
        top_genes.truncate(10);

        let daily = DailyStats {
            date: today,
            new_submissions: added as u32,
            reclassifications: reclassified.len() as u32,
            vus_to_pathogenic: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Vus) && matches!(r.new, Classification::Pathogenic))
                .count() as u32,
            vus_to_benign: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Vus) && matches!(r.new, Classification::Benign | Classification::LikelyBenign))
                .count() as u32,
            pathogenic_to_vus: reclassified.iter()
                .filter(|r| matches!(r.old, Classification::Pathogenic) && matches!(r.new, Classification::Vus))
                .count() as u32,
            top_genes,
        };
        cv_state.daily_stats.push(daily);

        // 6. Telegram notifications
        if !dry_run && !reclassified.is_empty() && cv.notify_reclassifications {
            let msg = format_telegram_digest(&cv_state, &reclassified, added);
            crate::notify::send_telegram(&msg, "de").await.ok();
        }
    }

    // 7. Compute aggregate stats
    let agg = stats::compute_aggregates(&cv_state);

    // 8. Generate HTML widget
    if cv.generate_html {
        let html = reporter::generate_widget(&agg, &cv_state);
        let widget_path = format!("{}/index.html", staging_dir);
        std::fs::write(&widget_path, &html)?;
        tracing::info!("[clinvar] Widget written to {}", widget_path);
    }

    // 9. Save state
    cv_state.save(&staging_dir)?;
    tracing::info!("[clinvar] State saved. Total: {} variants, {} reclassifications.",
        cv_state.variants.len(), cv_state.reclassifications.len());

    Ok(())
}

fn format_telegram_digest(state: &state::ClinVarState, reclass: &[ReclassificationEvent], added: usize) -> String {
    let mut msg = format!("📊 ClinVar Daily\n+{} Submissions | {} Reklassifizierungen\n",
        added, reclass.len());

    for r in reclass.iter().take(5) {
        msg.push_str(&format!("{} {}: {} → {}\n",
            r.gene, &r.hgvs[..r.hgvs.len().min(30)], r.old.short(), r.new.short()));
    }
    if reclass.len() > 5 {
        msg.push_str(&format!("... und {} weitere\n", reclass.len() - 5));
    }

    msg.push_str(&format!("Gesamt: {} tracked", state.variants.len()));
    msg
}
