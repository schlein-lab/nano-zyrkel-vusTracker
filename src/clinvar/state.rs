//! Persistent state — JSONL storage for variants, reclassifications, daily stats.

use anyhow::Result;
use super::{ClinVarVariant, ReclassificationEvent, DailyStats};

/// Complete ClinVar tracker state (loaded/saved between runs).
#[derive(Debug, Clone, Default)]
pub struct ClinVarState {
    pub variants: Vec<ClinVarVariant>,
    pub reclassifications: Vec<ReclassificationEvent>,
    pub daily_stats: Vec<DailyStats>,
    pub last_fetch_date: String,
}

impl ClinVarState {
    /// Load state from staging directory (JSONL files).
    pub fn load(staging_dir: &str) -> Self {
        Self {
            variants: load_jsonl(&format!("{}/variants.jsonl", staging_dir)),
            reclassifications: load_jsonl(&format!("{}/reclassifications.jsonl", staging_dir)),
            daily_stats: load_jsonl(&format!("{}/daily_stats.jsonl", staging_dir)),
            last_fetch_date: std::fs::read_to_string(format!("{}/last_fetch.txt", staging_dir))
                .unwrap_or_default()
                .trim()
                .to_string(),
        }
    }

    /// Save state to staging directory.
    pub fn save(&self, staging_dir: &str) -> Result<()> {
        save_jsonl(&format!("{}/variants.jsonl", staging_dir), &self.variants)?;
        save_jsonl(&format!("{}/reclassifications.jsonl", staging_dir), &self.reclassifications)?;
        save_jsonl(&format!("{}/daily_stats.jsonl", staging_dir), &self.daily_stats)?;
        std::fs::write(
            format!("{}/last_fetch.txt", staging_dir),
            chrono::Utc::now().format("%Y-%m-%d").to_string(),
        )?;
        Ok(())
    }
}

fn load_jsonl<T: serde::de::DeserializeOwned>(path: &str) -> Vec<T> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn save_jsonl<T: serde::Serialize>(path: &str, items: &[T]) -> Result<()> {
    let content: String = items.iter()
        .filter_map(|item| serde_json::to_string(item).ok())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(path, content + "\n")?;
    Ok(())
}
