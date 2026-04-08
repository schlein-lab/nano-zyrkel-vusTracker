//! Maildesk — semi-autonomous email agent with Telegram approval.
//!
//! Architecture:
//!   1. imap_client: fetch unread emails from IMAP
//!   2. analyzer: extract text + Codex analysis → structured plan
//!   3. drafter: Codex drafts professional reply
//!   4. telegram: send draft for approval, process commands
//!   5. sender: render HTML + send via SMTP on approval
//!
//! Each module is independent and testable.

pub mod imap_client;
pub mod analyzer;
pub mod drafter;
pub mod telegram;
pub mod sender;

use anyhow::{Context, Result};
use crate::config::{HatConfig, MaildeskConfig};

/// Run one complete maildesk cycle.
pub async fn run_maildesk(config: &HatConfig, dry_run: bool) -> Result<()> {
    let md = config.maildesk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("maildesk config missing — add 'maildesk' section to config JSON"))?;

    let smtp_user = std::env::var("SMTP_USER")
        .with_context(|| "SMTP_USER env var required for maildesk")?;
    let smtp_pass = std::env::var("SMTP_PASS")
        .with_context(|| "SMTP_PASS env var required for maildesk")?;

    let staging_dir = format!("{}/{}", config.output_dir, config.id);
    std::fs::create_dir_all(format!("{}/inbox", staging_dir))?;
    std::fs::create_dir_all(format!("{}/cases", staging_dir))?;

    // Load or initialize state
    let state_path = format!("{}/state.json", staging_dir);
    let mut state = MaildeskState::load(&state_path);

    // 1. Process pending Telegram commands
    tracing::info!("[maildesk] Processing Telegram commands...");
    telegram::process_commands(&mut state, md, &staging_dir, &smtp_user, &smtp_pass, dry_run).await;

    // 2. Fetch unseen emails
    tracing::info!("[maildesk] Fetching unseen emails...");
    let uids = imap_client::fetch_unseen(&md.imap_host, &smtp_user, &smtp_pass).await?;
    tracing::info!("[maildesk] Found {} unseen UIDs", uids.len());

    // 3. Process each new email
    let mut processed = 0u32;
    for uid in &uids {
        if state.is_processed(uid) {
            continue;
        }

        tracing::info!("[maildesk] Processing UID {}...", uid);

        // Download email
        let eml_path = format!("{}/inbox/{}.eml", staging_dir, uid);
        imap_client::fetch_email(&md.imap_host, &smtp_user, &smtp_pass, uid, &eml_path).await?;

        // Parse headers
        let headers = imap_client::parse_headers(&eml_path)?;

        // Self-mail filter
        if headers.from_email.to_lowercase() == smtp_user.to_lowercase() {
            tracing::info!("[maildesk] Skipping self-sent: {}", headers.subject);
            state.mark_processed(uid);
            continue;
        }

        tracing::info!("[maildesk] From: {} | Subject: {}", headers.from_email, headers.subject);

        // Extract body text
        let body = imap_client::extract_body_text(&eml_path, md.max_codex_chars)?;

        // Analyze with Codex
        tracing::info!("[maildesk] Analyzing...");
        let plan = analyzer::analyze(&headers, &body, &smtp_user).await?;

        // Draft reply
        tracing::info!("[maildesk] Drafting reply...");
        let draft = drafter::draft_reply(&headers, &plan, md).await?;

        // Create case
        let case_id = format!("mail-{}-{}", chrono::Utc::now().format("%Y%m%d"), uid);
        let case = Case {
            id: case_id.clone(),
            uid: uid.clone(),
            from_email: headers.from_email.clone(),
            from_header: headers.from_raw.clone(),
            subject: headers.subject.clone(),
            summary: plan.summary.clone(),
            reply_brief: plan.reply_brief.clone(),
            draft: draft.clone(),
            status: "awaiting_approval".into(),
        };

        let case_path = format!("{}/cases/{}.json", staging_dir, case_id);
        let case_json = serde_json::to_string_pretty(&case)?;
        std::fs::write(&case_path, &case_json)?;

        // Save draft
        let draft_path = format!("{}/cases/{}.reply.txt", staging_dir, case_id);
        std::fs::write(&draft_path, &draft)?;

        // Notify via Telegram
        if !dry_run {
            telegram::send_case_review(&case, md.max_preview_chars).await;
        }

        state.mark_processed(uid);
        state.add_pending(&case_id);
        processed += 1;

        if processed >= md.max_emails {
            break;
        }
    }

    // Save state
    state.save(&state_path)?;

    tracing::info!("[maildesk] Run complete. Processed {} new emails.", processed);
    Ok(())
}

/// Persistent state between runs.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MaildeskState {
    pub processed_uids: Vec<String>,
    pub pending_ids: Vec<String>,
    pub telegram_offset: i64,
}

impl MaildeskState {
    fn load(path: &str) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Self {
                processed_uids: vec![],
                pending_ids: vec![],
                telegram_offset: 0,
            })
    }

    fn save(&self, path: &str) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    fn is_processed(&self, uid: &str) -> bool {
        self.processed_uids.iter().any(|u| u == uid)
    }

    fn mark_processed(&mut self, uid: &str) {
        if !self.is_processed(uid) {
            self.processed_uids.push(uid.to_string());
        }
    }

    fn add_pending(&mut self, case_id: &str) {
        self.pending_ids.push(case_id.to_string());
    }
}

/// A maildesk case (one incoming email).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Case {
    pub id: String,
    pub uid: String,
    pub from_email: String,
    pub from_header: String,
    pub subject: String,
    pub summary: String,
    pub reply_brief: String,
    pub draft: String,
    pub status: String,
}
