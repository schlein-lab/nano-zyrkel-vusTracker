//! vus-tracker CLI — thin wrapper around `nano-zyrkel-core::Runtime`.
//!
//! Generic responsibilities (config parsing, fetchers, conditions,
//! notifications, runtime dispatch) live in the central
//! `nano-zyrkel-core` library. This binary keeps just two things:
//!
//! 1. CLI argument parsing.
//! 2. The vus-tracker-specific ClinVar pipeline in `clinvar_runner` —
//!    the modern, HPO-aware variant tracker that is the entire point
//!    of this user repo.
//!
//! Everything else is delegated to the central runtime.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

use nano_zyrkel_core::{HatConfig, HatType, RunOptions, Runtime};

mod clinvar;
mod clinvar_runner;

#[derive(Parser, Debug)]
#[command(name = "vus-tracker", about = "ClinVar VUS reclassification tracker")]
struct Cli {
    /// Path to nano config JSON.
    #[arg(short, long)]
    config: PathBuf,

    /// Output language for messages (de | en).
    #[arg(short, long, default_value = "en")]
    lang: String,

    /// Dry run — fetch and evaluate but do not notify or commit.
    #[arg(long)]
    dry_run: bool,

    /// Verbose output.
    #[arg(short, long)]
    verbose: bool,

    /// Optional ClinVar bulk file (variant_summary.txt) for one-time
    /// backfill imports — handled by this repo's domain pipeline.
    #[arg(long)]
    backfill: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            if cli.verbose {
                "vus_tracker=debug,nano_zyrkel_core=debug".into()
            } else {
                "vus_tracker=info,nano_zyrkel_core=info".into()
            }
        }))
        .compact()
        .init();

    let config = HatConfig::load(&cli.config)
        .with_context(|| format!("Failed to load config: {}", cli.config.display()))?;

    // ── Backfill: vus-tracker's own ClinVar import path ──────────────
    if let Some(path) = &cli.backfill {
        let staging_dir = format!("{}/{}", config.output_dir, config.id);
        std::fs::create_dir_all(&staging_dir)?;
        return clinvar::backfill::run_backfill(&path.to_string_lossy(), &staging_dir);
    }

    // ── ClinVar mode: use this repo's own modern tracker ─────────────
    if matches!(config.hat_type, HatType::ClinVar) {
        return clinvar_runner::run_clinvar(&config, cli.dry_run).await;
    }

    // ── Anything else: delegate to the central runtime ───────────────
    let opts = RunOptions {
        lang: cli.lang,
        dry_run: cli.dry_run,
        backfill: None,
    };
    Runtime::new(config).run(opts).await
}
