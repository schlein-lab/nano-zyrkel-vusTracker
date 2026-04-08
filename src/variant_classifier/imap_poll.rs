//! IMAP inbox polling for email-triggered variant classification.
//!
//! Watches for emails with trigger keywords (acmg, classify, variante, variant)
//! in the subject line. Parses variant from body, classifies, replies.

use anyhow::{Context, Result};
use super::{ClassifierState, do_classify, do_predict};
use super::parser;
use super::report;
use super::watchlist::Watchlist;
use crate::config::HatConfig;

/// Poll IMAP inbox for variant classification requests.
pub async fn poll(
    config: &HatConfig,
    state: &mut ClassifierState,
    watchlist: &mut Watchlist,
    http_client: &reqwest::Client,
    dry_run: bool,
) -> Result<()> {
    let vc = config.variant_classifier.as_ref()
        .ok_or_else(|| anyhow::anyhow!("variant_classifier config missing"))?;

    let smtp_user = std::env::var("SMTP_USER")
        .with_context(|| "SMTP_USER not set")?;
    let smtp_pass = std::env::var("SMTP_PASS")
        .with_context(|| "SMTP_PASS not set")?;

    let triggers: Vec<String> = vc.trigger_keywords.iter()
        .map(|k| k.to_lowercase()).collect();

    // Connect IMAP
    let tls = native_tls::TlsConnector::new()?;
    let client = imap::connect(
        (&*vc.imap_host, 993u16),
        &vc.imap_host,
        &tls,
    ).context("IMAP connection failed")?;

    let mut session = client.login(&smtp_user, &smtp_pass)
        .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

    session.select("INBOX")?;
    let uids = session.uid_search("UNSEEN")?;

    if uids.is_empty() {
        tracing::info!("[imap-poll] no new messages");
        session.logout().ok();
        return Ok(());
    }

    for uid in uids.iter() {
        let uid_str = uid.to_string();
        if state.processed_ids.contains(&uid_str) {
            continue;
        }

        let messages = session.uid_fetch(uid.to_string(), "RFC822")?;
        let msg = match messages.iter().next() {
            Some(m) => m,
            None => continue,
        };
        let raw_body = match msg.body() {
            Some(b) => b,
            None => continue,
        };

        let parsed = match mailparse::parse_mail(raw_body) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("[imap-poll] parse failed: {}", e);
                continue;
            }
        };

        // Extract subject
        let subject = parsed.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("subject"))
            .map(|h| h.get_value())
            .unwrap_or_default();

        // Check trigger keywords
        let subj_lower = subject.to_lowercase();
        if !triggers.iter().any(|t| subj_lower.contains(t.as_str())) {
            continue;
        }

        // Extract sender
        let from_raw = parsed.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("from"))
            .map(|h| h.get_value())
            .unwrap_or_default();
        let sender = extract_email(&from_raw).to_lowercase();

        // Bouncer check
        if !vc.allowed_addresses.is_empty() || !vc.allowed_domains.is_empty() {
            let domain = sender.split('@').nth(1).unwrap_or("");
            let allowed = vc.allowed_addresses.iter().any(|a| a.to_lowercase() == sender)
                || vc.allowed_domains.iter().any(|d| d.to_lowercase() == domain);
            if !allowed {
                tracing::info!("[imap-poll] rejected {}", sender);
                super::telegram::notify(&format!(
                    "⚠️ ACMG Anfrage abgelehnt: <code>{}</code>\nBetreff: {}",
                    sender, subject,
                )).await;
                continue;
            }
        }

        // Extract body text
        let body_text = parsed.subparts.iter()
            .find(|p| p.ctype.mimetype == "text/plain")
            .and_then(|p| p.get_body().ok())
            .or_else(|| parsed.get_body().ok())
            .unwrap_or_default();

        let variant_text = if body_text.trim().is_empty() { &subject } else { body_text.trim() };

        // Try to parse variant
        let variant = match parser::parse(variant_text).await {
            Ok(Some(v)) => v,
            Ok(None) => {
                super::telegram::notify(&format!(
                    "⚠️ ACMG Anfrage — keine Variante erkannt\nVon: <code>{}</code>\nText: {}",
                    sender, &variant_text[..variant_text.len().min(200)],
                )).await;
                state.processed_ids.push(uid_str);
                continue;
            }
            Err(e) => {
                tracing::warn!("[imap-poll] parse error: {}", e);
                state.processed_ids.push(uid_str);
                continue;
            }
        };

        // Determine action
        let is_predict = subj_lower.contains("predict") || subj_lower.contains("score");

        tracing::info!("[imap-poll] {} from {}: {}",
            if is_predict { "predict" } else { "classify" },
            sender, variant.display_name);

        super::telegram::notify(&format!(
            "🧬 ACMG {}: <code>{}</code>\nVon: <code>{}</code>",
            if is_predict { "predict" } else { "classify" },
            variant.display_name, sender,
        )).await;

        if !dry_run {
            if is_predict {
                match do_predict(variant_text, http_client).await {
                    Ok((v, mv_data)) => {
                        let html = report::prediction_html(&v, &mv_data);
                        send_reply(&vc.smtp_host, &smtp_user, &smtp_pass, &vc.reply_name,
                            &sender, &format!("ACMG Prediction: {}", v.display_name), &html).await?;
                    }
                    Err(e) => {
                        send_reply(&vc.smtp_host, &smtp_user, &smtp_pass, &vc.reply_name,
                            &sender, "ACMG Fehler", &format!("<p>{}</p>", e)).await?;
                    }
                }
            } else {
                match do_classify(variant_text, config, watchlist, http_client, &sender, "email").await {
                    Ok((v, acmg)) => {
                        let html = report::classification_html(&v, &acmg);
                        send_reply(&vc.smtp_host, &smtp_user, &smtp_pass, &vc.reply_name,
                            &sender, &format!("ACMG: {} — {}", v.display_name, acmg.classification), &html).await?;
                    }
                    Err(e) => {
                        send_reply(&vc.smtp_host, &smtp_user, &smtp_pass, &vc.reply_name,
                            &sender, "ACMG Fehler", &format!("<p>{}</p>", e)).await?;
                    }
                }
            }
        }

        state.processed_ids.push(uid_str);
    }

    session.logout().ok();

    // Keep last 500 processed IDs
    if state.processed_ids.len() > 500 {
        let drain = state.processed_ids.len() - 500;
        state.processed_ids.drain(..drain);
    }

    Ok(())
}

async fn send_reply(
    smtp_host: &str,
    smtp_user: &str,
    smtp_pass: &str,
    reply_name: &str,
    to: &str,
    subject: &str,
    html_body: &str,
) -> Result<()> {
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::message::{Message, SinglePart, header::ContentType};

    let from = format!("{} <{}>", reply_name, smtp_user);
    let email = Message::builder()
        .from(from.parse()?)
        .to(to.parse()?)
        .subject(subject)
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html_body.to_string()),
        )?;

    let creds = Credentials::new(smtp_user.to_string(), smtp_pass.to_string());
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)?
        .credentials(creds)
        .build();

    mailer.send(email).await?;
    tracing::info!("[smtp] sent to {}: {}", to, subject);
    Ok(())
}

fn extract_email(from: &str) -> String {
    let re = regex::Regex::new(r"[\w.+-]+@[\w.-]+").unwrap();
    re.find(from).map(|m| m.as_str().to_string()).unwrap_or_default()
}
