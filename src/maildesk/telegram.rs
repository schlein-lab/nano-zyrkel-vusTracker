//! Telegram bot — sends case reviews, processes approval commands.

use super::{Case, MaildeskState};
use crate::config::MaildeskConfig;

/// Send a case review to Telegram with approval commands.
pub async fn send_case_review(case: &Case, max_preview: usize) {
    let draft_preview: String = case.draft.chars().take(max_preview).collect();

    let text = format!(
        "Neuer Fall:\n\n\
         Case: {}\n\
         Von: {}\n\
         Betreff: {}\n\n\
         {}\n\n\
         Vorschlag:\n{}\n\n\
         /approve {}\n\
         /revise {} <hinweis>\n\
         /reply {} <text>\n\
         /callback {}\n\
         /done {}\n\
         /bounce {} <grund>\n\
         /ignore {}",
        case.id, case.from_email, case.subject,
        case.summary, draft_preview,
        case.id, case.id, case.id, case.id, case.id, case.id, case.id,
    );

    send_message(&text).await;
}

/// Process pending Telegram commands (non-blocking, 1s poll).
pub async fn process_commands(
    state: &mut MaildeskState,
    _config: &MaildeskConfig,
    staging_dir: &str,
    smtp_user: &str,
    smtp_pass: &str,
    dry_run: bool,
) {
    let token = match std::env::var("TELEGRAM_BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => return,
    };
    let chat_id = match std::env::var("TELEGRAM_CHAT_ID") {
        Ok(c) => c,
        Err(_) => return,
    };

    let url = format!(
        "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=1",
        token, state.telegram_offset + 1
    );

    let resp = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(_) => return,
    };

    let results = match body["result"].as_array() {
        Some(r) => r,
        None => return,
    };

    for item in results {
        let update_id = item["update_id"].as_i64().unwrap_or(0);
        let msg_chat_id = item["message"]["chat"]["id"].as_i64()
            .map(|id| id.to_string())
            .unwrap_or_default();
        let text = item["message"]["text"].as_str().unwrap_or("");

        if msg_chat_id != chat_id {
            continue;
        }
        state.telegram_offset = update_id;

        let parts: Vec<&str> = text.splitn(3, ' ').collect();
        let cmd = parts.first().unwrap_or(&"");
        let arg1 = parts.get(1).unwrap_or(&"");
        let arg2 = parts.get(2).unwrap_or(&"");

        match *cmd {
            "/pending" => {
                if state.pending_ids.is_empty() {
                    send_message("Keine offenen Faelle.").await;
                } else {
                    send_message(&format!("Offen:\n{}", state.pending_ids.join("\n"))).await;
                }
            }
            "/approve" if !dry_run => {
                let case_path = format!("{}/cases/{}.json", staging_dir, arg1);
                let draft_path = format!("{}/cases/{}.reply.txt", staging_dir, arg1);
                if std::path::Path::new(&case_path).exists() {
                    if let Ok(case_str) = std::fs::read_to_string(&case_path) {
                        if let Ok(case) = serde_json::from_str::<Case>(&case_str) {
                            let draft = std::fs::read_to_string(&draft_path).unwrap_or_default();
                            if let Err(e) = super::sender::send_reply(&case, &draft, smtp_user, smtp_pass, _config).await {
                                send_message(&format!("Senden fehlgeschlagen: {}", e)).await;
                            } else {
                                state.pending_ids.retain(|id| id != *arg1);
                                send_message(&format!("Antwort fuer {} gesendet.", arg1)).await;
                            }
                        }
                    }
                } else {
                    send_message(&format!("Case {} nicht gefunden.", arg1)).await;
                }
            }
            "/done" => {
                state.pending_ids.retain(|id| id != *arg1);
                send_message(&format!("Case {} erledigt.", arg1)).await;
            }
            "/ignore" => {
                state.pending_ids.retain(|id| id != *arg1);
                send_message(&format!("Case {} ignoriert.", arg1)).await;
            }
            "/callback" if !dry_run => {
                let case_path = format!("{}/cases/{}.json", staging_dir, arg1);
                if let Ok(case_str) = std::fs::read_to_string(&case_path) {
                    if let Ok(case) = serde_json::from_str::<Case>(&case_str) {
                        let draft = "Vielen Dank fuer Ihre Nachricht. Ich melde mich zeitnah bei Ihnen.\n\nMit freundlichen Gruessen";
                        if let Err(e) = super::sender::send_reply(&case, draft, smtp_user, smtp_pass, _config).await {
                            send_message(&format!("Senden fehlgeschlagen: {}", e)).await;
                        } else {
                            state.pending_ids.retain(|id| id != *arg1);
                            send_message(&format!("Rueckruf-Nachricht fuer {} gesendet.", arg1)).await;
                        }
                    }
                }
            }
            "/digest" => {
                let pending = state.pending_ids.len();
                send_message(&format!("Maildesk: {} offene Faelle.", pending)).await;
            }
            "/help" | "/start" => {
                send_message("nano-zyrkel maildesk:\n\n\
                    /pending — Offene Faelle\n\
                    /approve <id> — Senden\n\
                    /revise <id> <hinweis> — Ueberarbeiten\n\
                    /reply <id> <text> — Eigenen Text\n\
                    /callback <id> — Rueckruf\n\
                    /done <id> — Erledigt\n\
                    /bounce <id> <grund> — Abweisen\n\
                    /ignore <id> — Ignorieren\n\
                    /digest — Zusammenfassung").await;
            }
            _ => {}
        }
    }
}

async fn send_message(text: &str) {
    let token = match std::env::var("TELEGRAM_BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => return,
    };
    let chat_id = match std::env::var("TELEGRAM_CHAT_ID") {
        Ok(c) => c,
        Err(_) => return,
    };

    let payload = serde_json::json!({
        "chat_id": chat_id,
        "text": &text[..text.len().min(3900)],
        "disable_web_page_preview": true,
    });

    let _ = reqwest::Client::new()
        .post(format!("https://api.telegram.org/bot{}/sendMessage", token))
        .json(&payload)
        .send()
        .await;
}
