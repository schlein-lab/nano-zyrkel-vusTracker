use anyhow::{Context, Result};
use crate::config::Source;

const USER_AGENT: &str = "ZyrkelHAT/0.1 (https://github.com/christian-schlein/zyrkel)";
const TIMEOUT_SECS: u64 = 30;
const MAX_RETRIES: u32 = 3;
const RETRY_DELAY_MS: u64 = 2000;

/// Fetch content from a source URL with retry logic.
pub async fn fetch_source(source: &Source) -> Result<String> {
    let mut last_err = None;

    for attempt in 1..=MAX_RETRIES {
        match fetch_once(source).await {
            Ok(body) => return Ok(body),
            Err(e) => {
                tracing::warn!(attempt, max = MAX_RETRIES, error = %e, "Fetch attempt failed");
                last_err = Some(e);
                if attempt < MAX_RETRIES {
                    let delay = RETRY_DELAY_MS * (attempt as u64);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("fetch failed")))
}

async fn fetch_once(source: &Source) -> Result<String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()?;

    let mut req = match source.method.to_uppercase().as_str() {
        "POST" => client.post(&source.url),
        "PUT" => client.put(&source.url),
        _ => client.get(&source.url),
    };

    for (key, value) in &source.headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(body) = &source.body {
        req = req.body(body.clone());
    }

    let response = req.send().await
        .with_context(|| format!("HTTP request to {}", source.url))?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("HTTP {} from {}", status, source.url);
    }

    let body = response.text().await
        .with_context(|| format!("Reading response body from {}", source.url))?;

    Ok(body)
}
