use anyhow::Result;
use crate::config::{HatConfig, Notify};
use crate::condition::ConditionResult;
use crate::i18n;

/// Send notifications for a HAT match.
pub async fn send(notify: &Notify, config: &HatConfig, result: &ConditionResult, lang: &str) -> Result<()> {
    let message = format_message(notify, config, result);

    if notify.telegram {
        send_telegram(&message, lang).await?;
    }

    if notify.email {
        tracing::warn!("Email notification not yet implemented");
    }

    Ok(())
}

fn format_message(notify: &Notify, config: &HatConfig, result: &ConditionResult) -> String {
    if let Some(template) = &notify.message {
        template
            .replace("{id}", &config.id)
            .replace("{description}", &config.description)
            .replace("{summary}", &result.summary)
            .replace("{url}", &config.source.as_ref().map(|s| s.url.as_str()).unwrap_or(""))
            .replace("{value}", &result.extracted_value
                .as_ref()
                .map(|v| v.to_string())
                .unwrap_or_default())
    } else {
        let mut msg = format!("🎯 HAT '{}'\n{}\n\n{}", config.id, config.description, result.summary);
        if notify.include_extracted {
            if let Some(val) = &result.extracted_value {
                msg.push_str(&format!("\n\nExtrahiert:\n{}", serde_json::to_string_pretty(val).unwrap_or_default()));
            }
        }
        if let Some(ref source) = config.source {
            msg.push_str(&format!("\n\nQuelle: {}", source.url));
        }
        msg
    }
}

pub async fn send_telegram(message: &str, lang: &str) -> Result<()> {
    let token = std::env::var("TELEGRAM_BOT_TOKEN")
        .map_err(|_| anyhow::anyhow!("TELEGRAM_BOT_TOKEN not set"))?;
    let chat_id = std::env::var("TELEGRAM_CHAT_ID")
        .map_err(|_| anyhow::anyhow!("TELEGRAM_CHAT_ID not set"))?;

    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);

    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML",
            "disable_web_page_preview": true,
        }))
        .send()
        .await?;

    if response.status().is_success() {
        tracing::info!("{}", i18n::msg(lang, "notify_telegram", &[]));
    } else {
        let body = response.text().await.unwrap_or_default();
        tracing::error!("{}", i18n::msg(lang, "notify_failed", &[&body]));
    }

    Ok(())
}
