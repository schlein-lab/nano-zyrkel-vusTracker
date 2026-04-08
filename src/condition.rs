use anyhow::{Context, Result};
use crate::config::{Condition, HatConfig};

/// Result of evaluating a HAT condition.
#[derive(Debug, Clone)]
pub struct ConditionResult {
    /// Did the condition match?
    pub matched: bool,
    /// Human-readable summary of what was found
    pub summary: String,
    /// Extracted value (for trackers, price monitors, etc.)
    pub extracted_value: Option<serde_json::Value>,
    /// Content hash for change detection
    pub content_hash: String,
}

/// Evaluate a condition against fetched content.
pub async fn evaluate(condition: &Condition, content: &str, config: &HatConfig) -> Result<ConditionResult> {
    let content_hash = hash_content(content);

    match condition {
        Condition::Contains { value, negate } => {
            let found = content.contains(value.as_str());
            let matched = if *negate { !found } else { found };
            Ok(ConditionResult {
                matched,
                summary: if matched {
                    format!("Text '{}' gefunden", value)
                } else {
                    String::new()
                },
                extracted_value: None,
                content_hash,
            })
        }

        Condition::Regex { pattern, negate } => {
            let re = regex::Regex::new(pattern)?;
            let found = re.is_match(content);
            let matched = if *negate { !found } else { found };
            let capture = if found {
                re.find(content).map(|m| m.as_str().to_string())
            } else {
                None
            };
            Ok(ConditionResult {
                matched,
                summary: capture.unwrap_or_default(),
                extracted_value: None,
                content_hash,
            })
        }

        Condition::CssSelector { selector, extract } => {
            let document = scraper::Html::parse_document(content);
            let sel = scraper::Selector::parse(selector)
                .map_err(|e| anyhow::anyhow!("Invalid CSS selector: {e:?}"))?;
            let element = document.select(&sel).next();
            let matched = element.is_some();
            let extracted = element.map(|el| {
                match extract.as_deref() {
                    Some(attr) => el.value().attr(attr).unwrap_or("").to_string(),
                    None => el.text().collect::<Vec<_>>().join(" ").trim().to_string(),
                }
            });
            Ok(ConditionResult {
                matched,
                summary: extracted.clone().unwrap_or_default(),
                extracted_value: extracted.map(|v| serde_json::Value::String(v)),
                content_hash,
            })
        }

        Condition::JsonPath { path, expected } => {
            use jsonpath_rust::JsonPathQuery;
            let json: serde_json::Value = serde_json::from_str(content)?;
            let result = json.path(path)?;

            let found_values: Vec<&serde_json::Value> = match &result {
                serde_json::Value::Array(arr) => arr.iter().collect(),
                other => vec![other],
            };

            let matched = if let Some(exp) = expected {
                found_values.iter().any(|v| *v == exp)
            } else {
                !found_values.is_empty() && found_values[0] != &serde_json::Value::Null
            };

            Ok(ConditionResult {
                matched,
                summary: found_values.first()
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                extracted_value: found_values.first().map(|v| (*v).clone()),
                content_hash,
            })
        }

        Condition::RssNewEntry => {
            // Simple RSS: check if any entry ID differs from last seen
            let has_new = if let Some(last_id) = &config.state.last_rss_id {
                // Look for <id> or <guid> tags
                let id_re = regex::Regex::new(r"<(?:id|guid)[^>]*>([^<]+)</(?:id|guid)>")?;
                if let Some(cap) = id_re.captures(content) {
                    let first_id = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                    first_id != last_id.as_str()
                } else {
                    false
                }
            } else {
                // First run — always match to establish baseline
                true
            };

            // Extract first entry ID for state
            let id_re = regex::Regex::new(r"<(?:id|guid)[^>]*>([^<]+)</(?:id|guid)>")?;
            let first_id = id_re.captures(content)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string());

            // Extract first entry title
            let title_re = regex::Regex::new(r"<title[^>]*>([^<]+)</title>")?;
            let titles: Vec<String> = title_re.captures_iter(content)
                .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
                .collect();
            let title = titles.get(1).or(titles.first()) // skip feed title, get first entry
                .cloned()
                .unwrap_or_default();

            Ok(ConditionResult {
                matched: has_new,
                summary: title,
                extracted_value: first_id.map(serde_json::Value::String),
                content_hash,
            })
        }

        Condition::Changed { selector, threshold } => {
            let relevant_content = if let Some(sel) = selector {
                let document = scraper::Html::parse_document(content);
                let sel = scraper::Selector::parse(sel)
                    .map_err(|e| anyhow::anyhow!("Invalid CSS selector: {e:?}"))?;
                document.select(&sel)
                    .map(|el| el.text().collect::<Vec<_>>().join(" "))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                content.to_string()
            };

            let new_hash = hash_content(&relevant_content);
            let changed = match &config.state.last_hash {
                Some(last) => {
                    if let Some(thresh) = threshold {
                        // Simple character-level difference ratio
                        let diff_ratio = char_diff_ratio(&relevant_content, &new_hash);
                        diff_ratio >= *thresh
                    } else {
                        &new_hash != last
                    }
                }
                None => true, // First run
            };

            Ok(ConditionResult {
                matched: changed,
                summary: if changed { "Inhalt hat sich geaendert".to_string() } else { String::new() },
                extracted_value: None,
                content_hash: new_hash,
            })
        }

        Condition::ExtractValue { selector, unit } => {
            let document = scraper::Html::parse_document(content);
            let sel = scraper::Selector::parse(selector)
                .map_err(|e| anyhow::anyhow!("Invalid CSS selector: {e:?}"))?;
            let text = document.select(&sel)
                .next()
                .map(|el| el.text().collect::<Vec<_>>().join(""))
                .unwrap_or_default();

            // Extract first number from text
            let num_re = regex::Regex::new(r"[\d.,]+")?;
            let value_str = num_re.find(&text)
                .map(|m| m.as_str().replace(',', "."))
                .unwrap_or_default();

            let value: f64 = value_str.parse().unwrap_or(0.0);
            let unit_str = unit.as_deref().unwrap_or("");

            Ok(ConditionResult {
                matched: true, // Trackers always "match" — they record data
                summary: format!("{}{}", value, unit_str),
                extracted_value: Some(serde_json::json!({
                    "value": value,
                    "unit": unit_str,
                    "raw": text.trim(),
                })),
                content_hash,
            })
        }

        Condition::DeadlineDate { date, remind_at_days } => {
            let deadline = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
            let today = chrono::Utc::now().date_naive();
            let days_left = (deadline - today).num_days();

            let should_remind = remind_at_days.iter().any(|&d| days_left == d as i64);
            let is_today = days_left == 0;
            let is_overdue = days_left < 0;

            Ok(ConditionResult {
                matched: should_remind || is_today || is_overdue,
                summary: if is_overdue {
                    format!("UEBERFAELLIG seit {} Tagen!", -days_left)
                } else if is_today {
                    "HEUTE!".to_string()
                } else {
                    format!("Noch {} Tage bis {}", days_left, date)
                },
                extracted_value: Some(serde_json::json!({ "days_left": days_left })),
                content_hash,
            })
        }

        Condition::Llm { question, model } => {
            // Stufe 2: LLM-based condition evaluation
            // Uses Codex CLI (codex exec) or falls back to raw Anthropic API
            let answer = call_llm(question, content, model).await?;

            // LLM returns JSON: { "match": true/false, "summary": "..." }
            let parsed: serde_json::Value = serde_json::from_str(&answer)
                .unwrap_or_else(|_| serde_json::json!({
                    "match": answer.to_lowercase().contains("ja")
                        || answer.to_lowercase().contains("yes")
                        || answer.to_lowercase().contains("true"),
                    "summary": answer,
                }));

            Ok(ConditionResult {
                matched: parsed["match"].as_bool().unwrap_or(false),
                summary: parsed["summary"].as_str().unwrap_or("").to_string(),
                extracted_value: Some(parsed),
                content_hash,
            })
        }
    }
}

fn hash_content(content: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn char_diff_ratio(_content: &str, _hash: &str) -> f64 {
    // Simplified — in practice, compare actual content
    // For now: any hash difference = 1.0 change
    1.0
}

/// Call LLM to evaluate a condition.
/// Priority:
///   1) Codex CLI (codex login session or OPENAI_API_KEY) — sync, direkt
///   2) Email → Zyrkel Headless (async, durch jede Firewall, IMAP)
///   3) CF Bus → Zyrkel Headless (async, braucht CF Account)
///   4) Anthropic API direct (ANTHROPIC_API_KEY, kostet Geld)
///   5) Give up
async fn call_llm(question: &str, content: &str, _model: &str) -> Result<String> {
    let max_content = 8000;
    let truncated = if content.len() > max_content {
        &content[..max_content]
    } else {
        content
    };

    let prompt = format!(
        "Analysiere den folgenden Webseiten-Inhalt und beantworte die Frage.\n\
         Antworte NUR mit JSON: {{\"match\": true/false, \"summary\": \"kurze Zusammenfassung\"}}\n\n\
         FRAGE: {}\n\n\
         INHALT:\n{}",
        question, truncated
    );

    // 1. Try Codex CLI (sync — uses login session or OPENAI_API_KEY)
    if codex_available().await {
        match call_codex(&prompt).await {
            Ok(answer) => return Ok(answer),
            Err(e) => tracing::warn!("Codex CLI failed: {}", e),
        }
    }

    // 2. Try Email → Zyrkel Headless (async — through any firewall)
    if std::env::var("SMTP_USER").is_ok() {
        match llm_via_email(&prompt).await {
            Ok(answer) => return Ok(answer),
            Err(e) => tracing::warn!("Email LLM fallback failed: {}", e),
        }
    }

    // 3. Try CF Bus → Zyrkel Headless (async)
    if std::env::var("ZYRKEL_BUS_URL").is_ok() {
        match post_to_zyrkel_bus(&prompt).await {
            Ok(answer) => return Ok(answer),
            Err(e) => tracing::warn!("Zyrkel Bus fallback failed: {}", e),
        }
    }

    // 4. Try Anthropic API direct
    if let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") {
        return call_anthropic(&api_key, &prompt).await;
    }

    anyhow::bail!(
        "Kein LLM verfuegbar. Optionen:\n\
         1) codex login (Codex CLI)\n\
         2) SMTP_USER/SMTP_PASS/IMAP_HOST setzen (Email async via Headless)\n\
         3) ZYRKEL_BUS_URL setzen (CF Bus async via Headless)\n\
         4) ANTHROPIC_API_KEY setzen (direkte API)"
    )
}

/// Check if codex CLI is available in PATH
async fn codex_available() -> bool {
    tokio::process::Command::new("codex")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Call Codex CLI as subprocess: codex exec -o output.json "prompt"
async fn call_codex(prompt: &str) -> Result<String> {
    let output_file = format!("/tmp/nano-zyrkel-llm-{}.txt", std::process::id());

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new("codex")
            .args([
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "-o", &output_file,
                prompt,
            ])
            .output(),
    )
    .await
    .with_context(|| "Codex CLI timeout after 120s")?
    .with_context(|| "Codex CLI execution failed")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("Codex CLI error: {}", stderr.chars().take(200).collect::<String>());
    }

    // Read the output file
    let answer = tokio::fs::read_to_string(&output_file).await
        .with_context(|| format!("Failed to read Codex output from {}", output_file))?;

    // Clean up
    let _ = tokio::fs::remove_file(&output_file).await;

    tracing::debug!("Codex CLI response: {}", answer.chars().take(200).collect::<String>());
    Ok(answer.trim().to_string())
}

/// Fallback 2: Email → Zyrkel Headless.
/// Sends LLM question via SMTP, checks IMAP for answer.
/// Headless reads IMAP, makes LLM call, replies.
/// nano-zyrkel picks up reply on this or next run.
///
/// Env vars: SMTP_USER, SMTP_PASS, SMTP_HOST, IMAP_HOST, NANO_ID
async fn llm_via_email(prompt: &str) -> Result<String> {
    let smtp_user = std::env::var("SMTP_USER")?;
    let smtp_pass = std::env::var("SMTP_PASS")?;
    let smtp_host = std::env::var("SMTP_HOST").unwrap_or_else(|_| "smtp.gmail.com".into());
    let nano_id = std::env::var("NANO_ID").unwrap_or_else(|_| "unknown".into());

    // First: check staging/ for a pending answer (Headless pushes it via git)
    if let Some(answer) = check_staging_for_answer(&nano_id) {
        tracing::info!("Got pending LLM answer from Headless (via staging/)");
        return Ok(answer);
    }

    // No pending answer — send the question via SMTP
    send_llm_request_email(&smtp_host, &smtp_user, &smtp_pass, &nano_id, prompt).await?;

    tracing::info!("LLM request sent via Email — Headless will answer async");
    Ok(serde_json::json!({
        "match": false,
        "summary": "LLM-Anfrage per Email gesendet. Antwort kommt beim naechsten Run."
    }).to_string())
}

/// Check staging/ for a pending LLM answer from Headless.
/// Headless reads the email, makes LLM call, pushes answer as file into the repo.
fn check_staging_for_answer(nano_id: &str) -> Option<String> {
    let path = format!("staging/{}/llm-answer.json", nano_id);
    if let Ok(content) = std::fs::read_to_string(&path) {
        let _ = std::fs::remove_file(&path); // consume answer
        Some(content)
    } else {
        None
    }
}

/// Send LLM request via SMTP to the shared mailbox (Headless picks it up)
async fn send_llm_request_email(host: &str, user: &str, pass: &str, nano_id: &str, prompt: &str) -> Result<()> {
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::message::Message;

    let subject = format!("nano:llm:{}:{}", nano_id, chrono::Utc::now().timestamp());

    let email = Message::builder()
        .from(user.parse()?)
        .to(user.parse()?)  // Send to self — Headless reads same mailbox
        .subject(&subject)
        .body(prompt.to_string())?;

    let creds = Credentials::new(user.to_string(), pass.to_string());
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)?
        .credentials(creds)
        .build();

    mailer.send(email).await?;
    Ok(())
}

/// Fallback 3: Post question to Zyrkel Headless via CF Bus.
/// Headless picks it up, makes the LLM call, posts answer back.
/// nano-zyrkel checks for pending answers at start of each run.
async fn post_to_zyrkel_bus(prompt: &str) -> Result<String> {
    let bus_url = std::env::var("ZYRKEL_BUS_URL")?;
    let bus_token = std::env::var("ZYRKEL_BUS_TOKEN").unwrap_or_default();
    let nano_id = std::env::var("NANO_ID").unwrap_or_else(|_| "unknown".to_string());

    let request_id = format!("llm-{}-{}", nano_id, chrono::Utc::now().timestamp());

    // First: check if there's a pending answer from a previous run
    let client = reqwest::Client::new();
    let pending_resp = client
        .get(format!("{}/msg?topic=nano/llm-answer/{}", bus_url, nano_id))
        .header("x-zyrkel-token", &bus_token)
        .send()
        .await?;

    if pending_resp.status().is_success() {
        let body: serde_json::Value = pending_resp.json().await?;
        if let Some(messages) = body["messages"].as_array() {
            if let Some(last) = messages.last() {
                if let Some(answer) = last["payload"].as_str() {
                    tracing::info!("Got pending LLM answer from Zyrkel Headless");
                    return Ok(answer.to_string());
                }
            }
        }
    }

    // No pending answer — post the question for Headless to pick up
    let resp = client
        .post(format!("{}/msg", bus_url))
        .header("x-zyrkel-token", &bus_token)
        .json(&serde_json::json!({
            "topic": format!("nano/llm-request/{}", nano_id),
            "payload": prompt,
            "sender": format!("nano:{}", nano_id),
            "request_id": request_id,
        }))
        .send()
        .await?;

    if resp.status().is_success() {
        tracing::info!("LLM request posted to Zyrkel Bus — Headless will answer async");
        // Return a "pending" result — the actual answer comes next run
        Ok(serde_json::json!({
            "match": false,
            "summary": "LLM-Anfrage an Zyrkel Headless gesendet. Antwort kommt beim naechsten Run."
        }).to_string())
    } else {
        anyhow::bail!("Failed to post to Zyrkel Bus: {}", resp.status())
    }
}

/// Fallback 3: raw Anthropic API call
async fn call_anthropic(api_key: &str, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 300,
            "messages": [{ "role": "user", "content": prompt }]
        }))
        .send()
        .await?;

    let body: serde_json::Value = response.json().await?;

    body["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("Unexpected Anthropic API response"))
}
