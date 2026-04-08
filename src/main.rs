use anyhow::{Context, Result};
use chrono::Timelike;
use clap::Parser;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

mod action;
mod clinvar;
mod config;
mod condition;
mod fetch;
mod i18n;
mod literature;
mod maildesk;
mod notify;
mod output;
mod variant_classifier;

use config::HatConfig;

#[derive(Parser, Debug)]
#[command(name = "nano-zyrkel", about = "nano-zyrkel — autonomous agent runner")]
struct Cli {
    /// Path to HAT config JSON
    #[arg(short, long)]
    config: PathBuf,

    /// Language for output messages (de, en)
    #[arg(short, long, default_value = "de")]
    lang: String,

    /// Dry run — don't notify or commit, just check
    #[arg(long)]
    dry_run: bool,

    /// Verbose output
    #[arg(short, long)]
    verbose: bool,

    /// Backfill: path to NCBI variant_summary.txt (one-time full ClinVar import)
    #[arg(long)]
    backfill: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| {
                    if cli.verbose { "nano_zyrkel=debug".into() } else { "nano_zyrkel=info".into() }
                }),
        )
        .compact()
        .init();

    // ── Backfill mode: one-time ClinVar full import ──
    if let Some(backfill_path) = &cli.backfill {
        let config = HatConfig::load(&cli.config)
            .with_context(|| format!("Failed to load config: {}", cli.config.display()))?;
        let staging_dir = format!("{}/{}", config.output_dir, config.id);
        return clinvar::backfill::run_backfill(
            &backfill_path.to_string_lossy(),
            &staging_dir,
        ).map_err(Into::into);
    }

    let config = HatConfig::load(&cli.config)
        .with_context(|| format!("Failed to load config: {}", cli.config.display()))?;

    tracing::info!(
        nano_id = %config.id,
        nano_type = %config.hat_type,
        "{}",
        i18n::msg(&cli.lang, "hat_starting", &[&config.id])
    );

    // ── Maildesk mode: completely different flow ──
    if matches!(config.hat_type, config::HatType::Maildesk) {
        return maildesk::run_maildesk(&config, cli.dry_run).await;
    }

    // ── Literature Alert: own pipeline (IMAP poll + multi-source crawl) ──
    if matches!(config.hat_type, config::HatType::LiteratureAlert) {
        let mode = std::env::var("RUN_MODE").unwrap_or_else(|_| {
            let hour = chrono::Utc::now().hour();
            if hour == 6 { "crawl".into() } else { "poll".into() }
        });
        return literature::run(&config, &mode, cli.dry_run, &cli.lang).await;
    }

    // ── Variant Classifier: ACMG classification + VUS watchlist ──
    if matches!(config.hat_type, config::HatType::VariantClassifier) {
        let mode = std::env::var("RUN_MODE").unwrap_or_else(|_| {
            let hour = chrono::Utc::now().hour();
            let minute = chrono::Utc::now().minute();
            if hour % 6 == 0 && minute < 15 { "vus-watch".into() } else { "poll".into() }
        });
        return variant_classifier::run(&config, &mode, cli.dry_run).await;
    }

    // ── ClinVar tracker: fetch variants, compute stats, generate widget ──
    if matches!(config.hat_type, config::HatType::ClinVar) {
        return clinvar::run_clinvar(&config, cli.dry_run).await;
    }

    // ── Standard nano mode: fetch → condition → notify → act ──
    let source = config.source.as_ref()
        .ok_or_else(|| anyhow::anyhow!("'source' required for hat_type={}", config.hat_type))?;
    let condition_cfg = config.condition.as_ref()
        .ok_or_else(|| anyhow::anyhow!("'condition' required for hat_type={}", config.hat_type))?;

    // 1. Fetch content — from local file (NANO_SOURCE_FILE) or HTTP
    let content = if let Ok(file_path) = std::env::var("NANO_SOURCE_FILE") {
        tracing::info!("Reading from local file: {}", file_path);
        tokio::fs::read_to_string(&file_path).await
            .with_context(|| format!("Failed to read {}", file_path))?
    } else {
        fetch::fetch_source(source).await
            .with_context(|| i18n::msg(&cli.lang, "fetch_failed", &[&source.url]))?
    };

    tracing::debug!(bytes = content.len(), "Content fetched");

    // 2. Evaluate condition
    let result = condition::evaluate(condition_cfg, &content, &config).await?;

    // 3. Write output to staging/
    output::write_result(&config, &result, cli.dry_run)?;

    // 4. If match: notify + act
    if result.matched {
        if !cli.dry_run {
            notify::send(&config.notify, &config, &result, &cli.lang).await?;
        }

        // 5. Execute action (the part that makes HATs agents, not just monitors)
        let outcome = action::execute(&config, &result, cli.dry_run, &cli.lang).await?;
        tracing::info!(
            "{}",
            i18n::msg(&cli.lang, "match_found", &[&config.id, &result.summary])
        );
        match &outcome {
            action::ActionOutcome::Executed { action_type, detail, success } => {
                tracing::info!("Action '{}': {} (success: {})", action_type, detail, success);
            }
            action::ActionOutcome::Denied => {
                tracing::info!("Action denied by user");
            }
            _ => {}
        }
    } else {
        tracing::info!(
            "{}",
            i18n::msg(&cli.lang, "no_match", &[&config.id])
        );
    }

    Ok(())
}
