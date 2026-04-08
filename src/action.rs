use anyhow::{Context, Result};
use crate::config::{Action, ApprovalLevel, HatConfig};
use crate::condition::ConditionResult;
use crate::i18n;

/// Execute the configured action after a match — with approval checks.
pub async fn execute(
    config: &HatConfig,
    result: &ConditionResult,
    dry_run: bool,
    lang: &str,
) -> Result<ActionOutcome> {
    let action = match &config.action {
        Some(a) => a,
        None => return Ok(ActionOutcome::NoAction),
    };

    if dry_run {
        tracing::info!("[DRY RUN] Would execute action: {:?}", action_label(action));
        return Ok(ActionOutcome::DryRun);
    }

    // Check approval level
    match &config.approval {
        ApprovalLevel::None => {}
        ApprovalLevel::LogOnly => {
            tracing::info!("Action logged: {}", action_label(action));
        }
        ApprovalLevel::AskFirst => {
            let approved = ask_telegram_approval(config, result, action, lang).await?;
            if !approved {
                tracing::info!("{}", i18n::msg(lang, "action_denied", &[&config.id]));
                return Ok(ActionOutcome::Denied);
            }
        }
        ApprovalLevel::WithinBudget { max_cost, currency } => {
            tracing::info!(
                "Action within budget: {:?} {}",
                max_cost,
                currency.as_deref().unwrap_or("EUR")
            );
        }
    }

    run_action(action, config, result, lang).await
}

fn run_action<'a>(
    action: &'a Action,
    config: &'a HatConfig,
    result: &'a ConditionResult,
    lang: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ActionOutcome>> + Send + 'a>> {
    Box::pin(run_action_inner(action, config, result, lang))
}

async fn run_action_inner(
    action: &Action,
    config: &HatConfig,
    result: &ConditionResult,
    lang: &str,
) -> Result<ActionOutcome> {
    match action {
        Action::HttpRequest { url, method, headers, body, body_template, content_type } => {
            let client = reqwest::Client::new();
            let actual_body = body_template
                .as_ref()
                .map(|t| interpolate(t, config, result))
                .or_else(|| body.clone());

            let mut req = match method.to_uppercase().as_str() {
                "POST" => client.post(url),
                "PUT" => client.put(url),
                "PATCH" => client.patch(url),
                "DELETE" => client.delete(url),
                _ => client.post(url),
            };

            if let Some(ct) = content_type {
                req = req.header("content-type", ct.as_str());
            }
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
            if let Some(b) = actual_body {
                req = req.body(b);
            }

            let resp = req.send().await
                .with_context(|| format!("HTTP action to {}", url))?;
            let status = resp.status();
            tracing::info!("HTTP action: {} {} → {}", method, url, status);

            Ok(ActionOutcome::Executed {
                action_type: "http_request".into(),
                detail: format!("{} {} → {}", method, url, status),
                success: status.is_success(),
            })
        }

        Action::GithubIssue { repo, title, body_template, labels } => {
            let token = std::env::var("GH_TOKEN")
                .or_else(|_| std::env::var("GITHUB_TOKEN"))
                .map_err(|_| anyhow::anyhow!("GH_TOKEN not set"))?;

            let body = body_template
                .as_ref()
                .map(|t| interpolate(t, config, result))
                .unwrap_or_else(|| format!("HAT '{}' match:\n\n{}", config.id, result.summary));

            let client = reqwest::Client::new();
            let resp = client
                .post(format!("https://api.github.com/repos/{}/issues", repo))
                .header("authorization", format!("Bearer {}", token))
                .header("user-agent", "ZyrkelHAT")
                .header("accept", "application/vnd.github+json")
                .json(&serde_json::json!({
                    "title": interpolate(title, config, result),
                    "body": body,
                    "labels": labels,
                }))
                .send()
                .await?;

            let status = resp.status();
            let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
            let issue_url = resp_body["html_url"].as_str().unwrap_or("unknown");

            tracing::info!("GitHub Issue created: {} ({})", issue_url, status);
            Ok(ActionOutcome::Executed {
                action_type: "github_issue".into(),
                detail: issue_url.to_string(),
                success: status.is_success(),
            })
        }

        Action::TriggerHat { repo, workflow, inputs } => {
            let token = std::env::var("GH_TOKEN")
                .or_else(|_| std::env::var("GITHUB_TOKEN"))
                .map_err(|_| anyhow::anyhow!("GH_TOKEN not set"))?;

            let client = reqwest::Client::new();
            let resp = client
                .post(format!(
                    "https://api.github.com/repos/{}/actions/workflows/{}/dispatches",
                    repo, workflow
                ))
                .header("authorization", format!("Bearer {}", token))
                .header("user-agent", "ZyrkelHAT")
                .header("accept", "application/vnd.github+json")
                .json(&serde_json::json!({
                    "ref": "master",
                    "inputs": inputs,
                }))
                .send()
                .await?;

            let status = resp.status();
            tracing::info!("Triggered HAT {}/{}: {}", repo, workflow, status);
            Ok(ActionOutcome::Executed {
                action_type: "trigger_hat".into(),
                detail: format!("{}/{}", repo, workflow),
                success: status.is_success(),
            })
        }

        Action::PublishApi { path } => {
            // Copy latest result to api/ directory for GitHub Pages
            let src = format!("{}/{}/latest.json", config.output_dir, config.id);
            let dst = format!("api/{}", path);
            if let Some(parent) = std::path::Path::new(&dst).parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&src, &dst)
                .with_context(|| format!("Copy {} → {}", src, dst))?;
            tracing::info!("Published API: {}", dst);
            Ok(ActionOutcome::Executed {
                action_type: "publish_api".into(),
                detail: dst,
                success: true,
            })
        }

        Action::Shell { command, timeout_secs } => {
            let timeout = timeout_secs.unwrap_or(30);
            let cmd_future = tokio::process::Command::new("bash")
                .arg("-c")
                .arg(command)
                .output();
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(timeout),
                cmd_future,
            )
            .await
            .with_context(|| format!("Shell timeout after {}s", timeout))?
            .with_context(|| "Shell execution failed")?;

            let success = output.status.success();
            let stdout = String::from_utf8_lossy(&output.stdout);
            tracing::info!("Shell action: {} (exit {})", command, output.status);
            if !stdout.is_empty() {
                tracing::debug!("stdout: {}", stdout.chars().take(500).collect::<String>());
            }

            Ok(ActionOutcome::Executed {
                action_type: "shell".into(),
                detail: format!("exit {}", output.status),
                success,
            })
        }

        Action::CloudBus { topic, payload_template } => {
            let bus_url = std::env::var("ZYRKEL_BUS_URL")
                .map_err(|_| anyhow::anyhow!("ZYRKEL_BUS_URL not set"))?;
            let bus_token = std::env::var("ZYRKEL_BUS_TOKEN")
                .map_err(|_| anyhow::anyhow!("ZYRKEL_BUS_TOKEN not set"))?;

            let payload = payload_template
                .as_ref()
                .map(|t| interpolate(t, config, result))
                .unwrap_or_else(|| serde_json::to_string(&serde_json::json!({
                    "hat_id": config.id,
                    "summary": result.summary,
                    "matched": result.matched,
                })).unwrap_or_default());

            let client = reqwest::Client::new();
            let resp = client
                .post(format!("{}/msg", bus_url))
                .header("x-zyrkel-token", &bus_token)
                .json(&serde_json::json!({
                    "topic": topic,
                    "payload": payload,
                    "sender": format!("hat:{}", config.id),
                }))
                .send()
                .await?;

            let status = resp.status();
            tracing::info!("CloudBus message to '{}': {}", topic, status);
            Ok(ActionOutcome::Executed {
                action_type: "cloud_bus".into(),
                detail: format!("topic: {}", topic),
                success: status.is_success(),
            })
        }

        Action::GithubPr { repo, branch, title, body_template, files } => {
            // Simplified: create branch + files + PR via GitHub API
            let token = std::env::var("GH_TOKEN")
                .or_else(|_| std::env::var("GITHUB_TOKEN"))
                .map_err(|_| anyhow::anyhow!("GH_TOKEN not set"))?;

            let body = body_template
                .as_ref()
                .map(|t| interpolate(t, config, result))
                .unwrap_or_else(|| format!("Automated by HAT '{}'", config.id));

            tracing::info!(
                "GitHub PR: {} → {}/{} ({} files)",
                branch, repo, title, files.len()
            );
            // Full implementation requires: get default branch SHA, create branch,
            // create/update files, create PR. For now, log intent.
            tracing::warn!("GitHub PR creation requires full Git tree API — not yet implemented");

            Ok(ActionOutcome::Executed {
                action_type: "github_pr".into(),
                detail: format!("{}: {}", repo, title),
                success: false, // not yet implemented
            })
        }

        Action::Chain { actions } => {
            let mut results = Vec::new();
            for (i, sub_action) in actions.iter().enumerate() {
                tracing::info!("Chain step {}/{}", i + 1, actions.len());
                let outcome = run_action(sub_action, config, result, lang).await?;
                let success = matches!(&outcome, ActionOutcome::Executed { success: true, .. });
                results.push(outcome);
                if !success {
                    tracing::warn!("Chain aborted at step {}", i + 1);
                    break;
                }
            }
            Ok(ActionOutcome::Executed {
                action_type: "chain".into(),
                detail: format!("{}/{} steps completed", results.len(), actions.len()),
                success: results.iter().all(|r| matches!(r, ActionOutcome::Executed { success: true, .. })),
            })
        }
    }
}

/// Ask the user via Telegram whether to proceed with the action.
async fn ask_telegram_approval(
    config: &HatConfig,
    result: &ConditionResult,
    action: &Action,
    _lang: &str,
) -> Result<bool> {
    let token = std::env::var("TELEGRAM_BOT_TOKEN")
        .map_err(|_| anyhow::anyhow!("TELEGRAM_BOT_TOKEN not set"))?;
    let chat_id = std::env::var("TELEGRAM_CHAT_ID")
        .map_err(|_| anyhow::anyhow!("TELEGRAM_CHAT_ID not set"))?;

    // Send approval request with inline keyboard
    let client = reqwest::Client::new();
    let approval_id = format!("hat_{}_{}", config.id, chrono::Utc::now().timestamp());

    let msg = format!(
        "🤖 HAT '{}' moechte handeln:\n\n\
         Treffer: {}\n\
         Aktion: {}\n\n\
         Ausfuehren?",
        config.id, result.summary, action_label(action)
    );

    let resp = client
        .post(format!("https://api.telegram.org/bot{}/sendMessage", token))
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": msg,
            "reply_markup": {
                "inline_keyboard": [[
                    { "text": "✅ Ja", "callback_data": format!("approve:{}", approval_id) },
                    { "text": "❌ Nein", "callback_data": format!("deny:{}", approval_id) },
                ]]
            }
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        anyhow::bail!("Failed to send approval request");
    }

    // Poll for response (max 5 minutes)
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
    let mut offset = 0i64;

    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let updates: serde_json::Value = client
            .get(format!(
                "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=5",
                token, offset
            ))
            .send()
            .await?
            .json()
            .await?;

        if let Some(results) = updates["result"].as_array() {
            for update in results {
                offset = update["update_id"].as_i64().unwrap_or(0) + 1;
                if let Some(callback) = update["callback_query"]["data"].as_str() {
                    if callback == format!("approve:{}", approval_id) {
                        // Acknowledge the callback
                        let callback_id = update["callback_query"]["id"].as_str().unwrap_or("");
                        let _ = client
                            .post(format!("https://api.telegram.org/bot{}/answerCallbackQuery", token))
                            .json(&serde_json::json!({
                                "callback_query_id": callback_id,
                                "text": "Genehmigt!"
                            }))
                            .send()
                            .await;
                        return Ok(true);
                    } else if callback == format!("deny:{}", approval_id) {
                        let callback_id = update["callback_query"]["id"].as_str().unwrap_or("");
                        let _ = client
                            .post(format!("https://api.github.com/bot{}/answerCallbackQuery", token))
                            .json(&serde_json::json!({
                                "callback_query_id": callback_id,
                                "text": "Abgelehnt."
                            }))
                            .send()
                            .await;
                        return Ok(false);
                    }
                }
            }
        }
    }

    tracing::warn!("Approval timeout — action denied by default");
    Ok(false)
}

fn action_label(action: &Action) -> String {
    match action {
        Action::HttpRequest { url, method, .. } => format!("{} {}", method, url),
        Action::GithubIssue { repo, title, .. } => format!("Issue: {} — {}", repo, title),
        Action::GithubPr { repo, title, .. } => format!("PR: {} — {}", repo, title),
        Action::TriggerHat { repo, workflow, .. } => format!("Trigger: {}/{}", repo, workflow),
        Action::PublishApi { path } => format!("Publish: api/{}", path),
        Action::Shell { command, .. } => format!("Shell: {}", &command[..command.len().min(50)]),
        Action::CloudBus { topic, .. } => format!("Bus: {}", topic),
        Action::Chain { actions } => format!("Chain ({} steps)", actions.len()),
    }
}

fn interpolate(template: &str, config: &HatConfig, result: &ConditionResult) -> String {
    template
        .replace("{id}", &config.id)
        .replace("{description}", &config.description)
        .replace("{summary}", &result.summary)
        .replace("{url}", &config.source.as_ref().map(|s| s.url.as_str()).unwrap_or(""))
        .replace("{value}", &result.extracted_value
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default())
}

#[derive(Debug)]
pub enum ActionOutcome {
    NoAction,
    DryRun,
    Denied,
    Executed {
        action_type: String,
        detail: String,
        success: bool,
    },
}
