//! Variant Classifier — ACMG classification, VUS watchlist, prediction aggregation.
//!
//! Architecture:
//!   1. parser:     Variant parsing (regex fast path + Codex LLM normalization)
//!   2. myvariant:  myvariant.info API client (ClinVar, gnomAD, CADD, dbNSFP)
//!   3. acmg:       ACMG criteria evaluation + 5-tier classification
//!   4. watchlist:  VUS watchlist management (auto-add, re-check, alert)
//!   5. telegram:   Telegram command handler (/classify, /predict, /vus_*)
//!   6. imap_poll:  Email inbox polling for email-triggered classification
//!   7. report:     HTML report builder for email responses
//!
//! Modes:
//!   poll      — Check inbox + Telegram for classification requests
//!   vus-watch — Re-check all VUS against ClinVar for reclassification
//!   auto      — poll most runs, vus-watch every 6h

pub mod parser;
pub mod myvariant;
pub mod acmg;
pub mod watchlist;
pub mod telegram;
pub mod imap_poll;
pub mod report;

use anyhow::Result;
use crate::config::HatConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Persistent state between runs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClassifierState {
    pub processed_ids: Vec<String>,
    pub tg_offset: i64,
    pub last_vus_check: Option<String>,
}

impl ClassifierState {
    fn load(path: &str) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, path: &str) -> Result<()> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

/// Run one complete variant classifier cycle.
pub async fn run(config: &HatConfig, mode: &str, dry_run: bool) -> Result<()> {
    let vc = config.variant_classifier.as_ref()
        .ok_or_else(|| anyhow::anyhow!("'variant_classifier' config section missing"))?;

    let staging_dir = format!("{}/{}", config.output_dir, config.id);
    std::fs::create_dir_all(&staging_dir)?;

    let state_path = format!("{}/state.json", staging_dir);
    let mut state = ClassifierState::load(&state_path);

    let wl_path = PathBuf::from(&vc.watchlist_path);
    let mut watchlist = watchlist::Watchlist::load(&wl_path);

    let http_client = reqwest::Client::builder()
        .user_agent("nano-zyrkel-variant-classifier/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    tracing::info!(mode, "Variant classifier starting");

    match mode {
        "poll" => {
            // Email poll
            if let Err(e) = imap_poll::poll(config, &mut state, &mut watchlist, &http_client, dry_run).await {
                tracing::warn!("[poll] IMAP error: {}", e);
            }
            // Telegram poll
            telegram::poll(config, &mut state, &mut watchlist, &http_client, dry_run).await;
        }
        "vus-watch" => {
            let changes = watchlist.watch(&http_client).await;
            if !changes.is_empty() {
                let mut msg = "<b>VUS Watchlist — Reklassifikation!</b>\n".to_string();
                for c in &changes {
                    msg.push_str(&format!(
                        "\n<code>{}</code> (von {})\n  {} → <b>{}</b>",
                        c.display_name, c.added_by, c.old_sig, c.new_sig,
                    ));
                    if !c.context.is_empty() {
                        msg.push_str(&format!("\n  📝 {}", &c.context[..c.context.len().min(100)]));
                    }
                }
                telegram::notify(&msg).await;

                // Write finding for nano-manager
                let finding = serde_json::json!({
                    "matched": true,
                    "summary": format!("VUS Reklassifikation: {}",
                        changes.iter().map(|c| c.display_name.as_str()).collect::<Vec<_>>().join(", ")),
                    "extracted_value": serde_json::to_string(&changes.iter().map(|c| {
                        serde_json::json!({"variant": c.display_name, "old": c.old_sig, "new": c.new_sig})
                    }).collect::<Vec<_>>()).unwrap_or_default(),
                    "content_hash": format!("{:x}", sha2::Sha256::digest(
                        changes.iter().map(|c| &c.display_name).cloned().collect::<Vec<_>>().join(",").as_bytes()
                    )),
                });
                std::fs::write(
                    format!("{}/latest.json", staging_dir),
                    serde_json::to_string_pretty(&finding)?,
                )?;
            } else {
                tracing::info!("[vus-watch] no changes for {} variants", watchlist.variants.len());
            }
        }
        _ => {
            tracing::warn!("Unknown mode '{}', defaulting to poll", mode);
            return Box::pin(run(config, "poll", dry_run)).await;
        }
    }

    // Persist state + watchlist
    watchlist.save(&wl_path)?;
    state.save(&state_path)?;

    tracing::info!("[variant-classifier] done (mode={})", mode);
    Ok(())
}

// ---------------------------------------------------------------------------
// Core operations (used by both telegram and imap_poll)
// ---------------------------------------------------------------------------

use sha2::Digest;

/// Classify a variant: parse → query → evaluate → auto-watchlist.
pub async fn do_classify(
    input: &str,
    config: &HatConfig,
    watchlist: &mut watchlist::Watchlist,
    client: &reqwest::Client,
    requester: &str,
    channel: &str,
) -> Result<(parser::Variant, acmg::AcmgResult)> {
    let variant = parser::parse(input).await?
        .ok_or_else(|| anyhow::anyhow!("Variante nicht erkannt: {}", &input[..input.len().min(100)]))?;

    tracing::info!("[classify] querying myvariant.info for: {}", variant.query);
    let mut mv_data = myvariant::query(client, &variant.query).await?;

    if mv_data.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        tracing::info!("[classify] myvariant empty, trying ClinVar direct");
        mv_data = myvariant::query_clinvar_direct(client, &variant.query).await?;
    }

    let af_threshold = config.variant_classifier.as_ref()
        .map(|vc| vc.gnomad_af_threshold)
        .unwrap_or(0.01);

    let acmg_result = acmg::evaluate(&mv_data, af_threshold);

    // Auto-add to watchlist
    let context = parser::extract_context(input, &variant);
    let wl_msg = watchlist.add(&variant, requester, channel, &context, &acmg_result.classification);
    tracing::info!("[classify] {}", wl_msg);

    Ok((variant, acmg_result))
}

/// Predict: parse → query → return raw scores.
pub async fn do_predict(
    input: &str,
    client: &reqwest::Client,
) -> Result<(parser::Variant, serde_json::Value)> {
    let variant = parser::parse(input).await?
        .ok_or_else(|| anyhow::anyhow!("Variante nicht erkannt: {}", &input[..input.len().min(100)]))?;

    let mv_data = myvariant::query(client, &variant.query).await?;
    Ok((variant, mv_data))
}
