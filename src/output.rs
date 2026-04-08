use anyhow::Result;
use crate::config::HatConfig;
use crate::condition::ConditionResult;

/// Write HAT result to staging directory and update state.
pub fn write_result(config: &HatConfig, result: &ConditionResult, dry_run: bool) -> Result<()> {
    let staging_dir = format!("{}/{}", config.output_dir, config.id);

    if dry_run {
        tracing::info!("[DRY RUN] Would write to {}/", staging_dir);
        return Ok(());
    }

    std::fs::create_dir_all(&staging_dir)?;

    // Write latest result
    let result_json = serde_json::json!({
        "hat_id": config.id,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "matched": result.matched,
        "summary": result.summary,
        "extracted_value": result.extracted_value,
        "content_hash": result.content_hash,
        "source_url": config.source.as_ref().map(|s| s.url.as_str()).unwrap_or(""),
    });

    let latest_path = format!("{}/latest.json", staging_dir);
    std::fs::write(&latest_path, serde_json::to_string_pretty(&result_json)?)?;

    // Append to history (JSONL format — one line per check)
    let history_path = format!("{}/history.jsonl", staging_dir);
    let line = serde_json::to_string(&result_json)? + "\n";
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&history_path)?;
    std::io::Write::write_all(&mut file, line.as_bytes())?;

    // Update state in config
    let mut updated_config = config.clone();
    updated_config.state.last_check = Some(chrono::Utc::now().to_rfc3339());
    updated_config.state.last_hash = Some(result.content_hash.clone());
    updated_config.state.total_runs += 1;
    if result.matched {
        updated_config.state.total_matches += 1;
        updated_config.state.consecutive_errors = 0;
    }

    if let Some(val) = &result.extracted_value {
        updated_config.state.last_value = Some(val.clone());
    }

    // For RSS, update last seen ID
    if let Some(crate::config::Condition::RssNewEntry) = &config.condition {
        if let Some(serde_json::Value::String(id)) = &result.extracted_value {
            updated_config.state.last_rss_id = Some(id.clone());
        }
    }

    // Save updated state back to config file
    let state_path = format!("{}/state.json", staging_dir);
    let state_json = serde_json::to_string_pretty(&updated_config.state)?;
    std::fs::write(&state_path, state_json)?;

    tracing::debug!("Output written to {}/", staging_dir);

    Ok(())
}
