//! Telegram command handler for variant classifier.
//!
//! Commands:
//!   /classify NM_000162.5:c.247G>A [optional notes]
//!   /predict chr7:117559590:A>G
//!   /vus_add NM_000162.5:c.247G>A [optional notes]
//!   /vus_list
//!   /vus_remove <variant>
//!   /help

use super::{ClassifierState, do_classify, do_predict};
use super::parser;
use super::watchlist::Watchlist;
use crate::config::HatConfig;

/// Process pending Telegram updates.
pub async fn poll(
    config: &HatConfig,
    state: &mut ClassifierState,
    watchlist: &mut Watchlist,
    client: &reqwest::Client,
    _dry_run: bool,
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
        "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=5",
        token, state.tg_offset + 1,
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
        let text = item["message"]["text"].as_str().unwrap_or("").trim();
        let username = item["message"]["from"]["username"].as_str().unwrap_or("telegram");

        if msg_chat_id != chat_id || text.is_empty() {
            state.tg_offset = update_id;
            continue;
        }
        state.tg_offset = update_id;

        let text_lower = text.to_lowercase();

        if text_lower.starts_with("/classify") {
            let input = text["/classify".len()..].trim();
            if input.is_empty() {
                send(&token, &chat_id, "Verwendung: /classify NM_000162.5:c.247G>A [optionale Notizen]").await;
                continue;
            }
            match do_classify(input, config, watchlist, client, username, "telegram").await {
                Ok((variant, acmg)) => {
                    let criteria_str = acmg.criteria_met.iter()
                        .map(|c| c.code.as_str()).collect::<Vec<_>>().join(", ");
                    let pred_lines: Vec<String> = acmg.evidence.predictors.iter()
                        .map(|p| format!("  {}: {:.3} ({:?})", p.name, p.score, p.verdict))
                        .collect();
                    let af_str = acmg.evidence.gnomad_af
                        .map(|v| format!("{:.6}", v))
                        .unwrap_or_else(|| "n/a".into());
                    let cv = acmg.evidence.clinvar_significance.as_deref().unwrap_or("nicht gelistet");
                    send(&token, &chat_id, &format!(
                        "🧬 <b>ACMG: {}</b>\n\n<b>{}</b>\n\nKriterien: {}\nClinVar: {}\ngnomAD AF: {}\n\nPredictors:\n{}\n\n📋 Automatisch auf Watchlist",
                        variant.display_name, acmg.classification,
                        if criteria_str.is_empty() { "keine" } else { &criteria_str },
                        cv, af_str, pred_lines.join("\n"),
                    )).await;
                }
                Err(e) => send(&token, &chat_id, &format!("❌ {}", e)).await,
            }

        } else if text_lower.starts_with("/predict") {
            let input = text["/predict".len()..].trim();
            if input.is_empty() {
                send(&token, &chat_id, "Verwendung: /predict chr7:117559590:A>G").await;
                continue;
            }
            match do_predict(input, client).await {
                Ok((variant, mv_data)) => {
                    let dbnsfp = &mv_data["dbnsfp"];
                    let cadd = super::myvariant::extract_score(&mv_data, &["cadd", "phred"])
                        .map(|v| format!("{:.2}", v)).unwrap_or_else(|| "n/a".into());
                    let revel = super::myvariant::extract_score(dbnsfp, &["revel", "score"])
                        .map(|v| format!("{:.4}", v)).unwrap_or_else(|| "n/a".into());
                    let splice = ["ds_ag","ds_al","ds_dg","ds_dl"].iter()
                        .filter_map(|k| super::myvariant::extract_score(dbnsfp, &["spliceai", k]))
                        .reduce(f64::max)
                        .map(|v| format!("{:.4}", v)).unwrap_or_else(|| "n/a".into());
                    let am = super::myvariant::extract_score(dbnsfp, &["alphamissense", "score"])
                        .map(|v| format!("{:.4}", v)).unwrap_or_else(|| "n/a".into());
                    send(&token, &chat_id, &format!(
                        "🔬 <b>Prediction: {}</b>\n\nCADD: {}\nREVEL: {}\nSpliceAI: {}\nAlphaMissense: {}",
                        variant.display_name, cadd, revel, splice, am,
                    )).await;
                }
                Err(e) => send(&token, &chat_id, &format!("❌ {}", e)).await,
            }

        } else if text_lower.starts_with("/vus_add") {
            let input = text["/vus_add".len()..].trim();
            if input.is_empty() {
                send(&token, &chat_id, "Verwendung: /vus_add NM_000162.5:c.247G>A [optionale Notizen]").await;
                continue;
            }
            match parser::parse(input).await {
                Ok(Some(variant)) => {
                    let context = parser::extract_context(input, &variant);
                    let msg = watchlist.add(&variant, username, "telegram", &context, &super::acmg::Classification::Vus);
                    send(&token, &chat_id, &format!("📋 {}", msg)).await;
                }
                Ok(None) => send(&token, &chat_id, "Variante nicht erkannt.").await,
                Err(e) => send(&token, &chat_id, &format!("❌ {}", e)).await,
            }

        } else if text_lower.starts_with("/vus_list") {
            send(&token, &chat_id, &watchlist.list()).await;

        } else if text_lower.starts_with("/vus_remove") {
            let input = text["/vus_remove".len()..].trim();
            if input.is_empty() {
                send(&token, &chat_id, "Verwendung: /vus_remove <variante>").await;
                continue;
            }
            let msg = watchlist.remove(input);
            send(&token, &chat_id, &msg).await;

        } else if text_lower.starts_with("/help") || text_lower.starts_with("/start") {
            send(&token, &chat_id,
                "nano-zyrkel variant-classifier:\n\n\
                 /classify <variante> [notizen] — ACMG-Klassifikation + auto-Watchlist\n\
                 /predict <variante> — In-silico Scores\n\
                 /vus_add <variante> [notizen] — Manuell zur Watchlist\n\
                 /vus_list — Watchlist anzeigen\n\
                 /vus_remove <variante> — VUS entfernen\n\n\
                 Oder einfach Variante + 'acmg' schicken."
            ).await;

        } else {
            // Trigger keyword detection: try classify if "acmg" in text
            let trigger_keywords = ["acmg", "classify", "variante", "vus"];
            if trigger_keywords.iter().any(|kw| text_lower.contains(kw)) {
                if let Ok(Some(variant)) = parser::parse(text).await {
                    if let Ok((_, acmg)) = do_classify(text, config, watchlist, client, username, "telegram").await {
                        let criteria_str = acmg.criteria_met.iter()
                            .map(|c| c.code.as_str()).collect::<Vec<_>>().join(", ");
                        send(&token, &chat_id, &format!(
                            "🧬 <b>{}</b>: <b>{}</b>\nKriterien: {}\n📋 Automatisch auf Watchlist",
                            variant.display_name, acmg.classification,
                            if criteria_str.is_empty() { "keine" } else { &criteria_str },
                        )).await;
                    }
                }
            }
        }
    }
}

async fn send(token: &str, chat_id: &str, text: &str) {
    let payload = serde_json::json!({
        "chat_id": chat_id,
        "text": &text[..text.len().min(3900)],
        "parse_mode": "HTML",
        "disable_web_page_preview": true,
    });
    let _ = reqwest::Client::new()
        .post(format!("https://api.telegram.org/bot{}/sendMessage", token))
        .json(&payload)
        .send()
        .await;
}

/// Send a standalone notification (used by vus-watch alerts).
pub async fn notify(msg: &str) {
    let token = match std::env::var("TELEGRAM_BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => return,
    };
    let chat_id = match std::env::var("TELEGRAM_CHAT_ID") {
        Ok(c) => c,
        Err(_) => return,
    };
    send(&token, &chat_id, msg).await;
}
