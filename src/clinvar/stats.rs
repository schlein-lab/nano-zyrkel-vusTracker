//! Statistical computations on accumulated ClinVar data.
//!
//! All computations run on in-memory JSONL data — no database, no GPU.
//! Designed to complete in <1 second even with 100k+ variants.

use std::collections::{HashMap, HashSet};
use chrono::Datelike;
use super::{Classification, AggregateStats};
use super::state::ClinVarState;

/// Compute all aggregate statistics from current state.
pub fn compute_aggregates(state: &ClinVarState) -> AggregateStats {
    let today = chrono::Utc::now().date_naive();

    AggregateStats {
        total_variants: state.variants.len() as u64,
        total_reclassifications: state.reclassifications.len() as u64,
        agent_start_date: state.daily_stats.first()
            .map(|d| d.date.clone())
            .unwrap_or_else(|| today.to_string()),
        concordance: lab_concordance(&state.variants),
        vus_half_life_by_gene: vus_half_life(state),
        gene_discord: gene_discord_score(&state.variants),
        monthly_trend: monthly_trend(&state.daily_stats),
        new_vus_today: count_new_vus_today(&state.variants),
        vus_to_path_30d: count_vus_to_path_30d(&state.reclassifications),
    }
}

/// VUS half-life: median days from first_seen to reclassification, per gene.
fn vus_half_life(state: &ClinVarState) -> Vec<(String, f64)> {
    let mut gene_days: HashMap<String, Vec<f64>> = HashMap::new();

    for event in &state.reclassifications {
        if !matches!(event.old, Classification::Vus) { continue; }

        let variant = state.variants.iter()
            .find(|v| v.variation_id == event.variation_id);

        if let Some(var) = variant {
            let first = chrono::NaiveDate::parse_from_str(&var.first_seen, "%Y-%m-%d").ok();
            let detected = chrono::NaiveDate::parse_from_str(&event.detected_at, "%Y-%m-%d").ok();
            if let (Some(f), Some(d)) = (first, detected) {
                let days = (d - f).num_days().max(1) as f64;
                gene_days.entry(event.gene.clone()).or_default().push(days);
            }
        }
    }

    let mut result: Vec<(String, f64)> = gene_days.into_iter()
        .filter(|(_, days)| !days.is_empty())
        .map(|(gene, mut days)| {
            days.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median = days[days.len() / 2];
            (gene, median)
        })
        .collect();

    result.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    result.truncate(20);
    result
}

/// Lab concordance: for variants with >1 submission, agreement rate.
fn lab_concordance(variants: &[super::ClinVarVariant]) -> f64 {
    let mut groups: HashMap<String, HashSet<String>> = HashMap::new();
    for v in variants {
        groups.entry(v.variation_id.clone()).or_default()
            .insert(v.classification.short().to_string());
    }

    let multi: Vec<_> = groups.values().filter(|g| g.len() > 0).collect();
    if multi.is_empty() { return 100.0; }

    let concordant = multi.iter().filter(|g| g.len() == 1).count();
    (concordant as f64 / multi.len() as f64) * 100.0
}

/// Gene discord score: fraction of discordant classifications per gene.
fn gene_discord_score(variants: &[super::ClinVarVariant]) -> Vec<(String, f64, u32)> {
    let mut gene_vars: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
    for v in variants {
        gene_vars.entry(v.gene.clone()).or_default()
            .entry(v.variation_id.clone()).or_default()
            .insert(v.classification.short().to_string());
    }

    let mut scores: Vec<(String, f64, u32)> = gene_vars.into_iter()
        .filter(|(_, vars)| vars.len() >= 3) // only genes with enough data
        .map(|(gene, vars)| {
            let total = vars.len() as u32;
            let discordant = vars.values().filter(|c| c.len() > 1).count() as f64;
            (gene, discordant / total as f64, total)
        })
        .collect();

    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scores.truncate(20);
    scores
}

/// Monthly trend: reclassifications this month vs last month.
fn monthly_trend(daily_stats: &[super::DailyStats]) -> (i32, String) {
    let today = chrono::Utc::now().date_naive();

    let this_month: u32 = daily_stats.iter()
        .filter_map(|s| {
            chrono::NaiveDate::parse_from_str(&s.date, "%Y-%m-%d").ok()
                .filter(|d| d.month() == today.month() && d.year() == today.year())
                .map(|_| s.reclassifications)
        })
        .sum();

    let last = today - chrono::Duration::days(30);
    let last_month: u32 = daily_stats.iter()
        .filter_map(|s| {
            chrono::NaiveDate::parse_from_str(&s.date, "%Y-%m-%d").ok()
                .filter(|d| d.month() == last.month() && d.year() == last.year())
                .map(|_| s.reclassifications)
        })
        .sum();

    let delta = this_month as i32 - last_month as i32;
    let trend = if delta > 2 { "rising".to_string() }
        else if delta < -2 { "falling".to_string() }
        else { "stable".to_string() };
    (delta, trend)
}

/// Count VUS seen today.
fn count_new_vus_today(variants: &[super::ClinVarVariant]) -> u32 {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    variants.iter()
        .filter(|v| matches!(v.classification, Classification::Vus) && v.first_seen == today)
        .count() as u32
}

/// Count VUS→pathogenic reclassifications in last 30 days.
fn count_vus_to_path_30d(reclassifications: &[super::ReclassificationEvent]) -> u32 {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d").to_string();
    reclassifications.iter()
        .filter(|r| matches!(r.old, Classification::Vus)
            && matches!(r.new, Classification::Pathogenic | Classification::LikelyPathogenic)
            && r.detected_at >= cutoff)
        .count() as u32
}
