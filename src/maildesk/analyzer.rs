//! Email analyzer — uses Codex CLI to understand incoming emails.
//! Produces a structured plan: needs_reply, summary, risk_flags, reply_brief.

use anyhow::Result;
use super::imap_client::EmailHeaders;

/// Structured analysis result from Codex.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AnalysisPlan {
    #[serde(default)]
    pub needs_reply: bool,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub risk_flags: Vec<String>,
    #[serde(default)]
    pub reply_brief: String,
    #[serde(default)]
    pub follow_up_questions: Vec<String>,
}

/// Analyze an email using Codex CLI.
pub async fn analyze(headers: &EmailHeaders, body: &str, mailbox: &str) -> Result<AnalysisPlan> {
    let prompt = format!(
        "Du bist der Maildesk-Agent fuer {}. Analysiere diese eingehende E-Mail.\n\n\
         VON: {}\n\
         BETREFF: {}\n\n\
         INHALT:\n{}\n\n\
         Antworte NUR mit JSON:\n\
         {{\"needs_reply\": true/false, \"summary\": \"2-3 Saetze\", \"risk_flags\": [], \
         \"reply_brief\": \"Kern der Antwort\", \"follow_up_questions\": []}}\n\n\
         Regeln:\n\
         - needs_reply: false bei Info-Mails, Newslettern, Spam.\n\
         - Keine Fakten erfinden.",
        mailbox, headers.from_raw, headers.subject, body
    );

    let output_file = format!("/tmp/nano-analyze-{}.json", std::process::id());

    let status = tokio::process::Command::new("codex")
        .args(["exec", "--skip-git-repo-check", "--ephemeral", "-o", &output_file])
        .arg(&prompt)
        .output()
        .await;

    let plan = match status {
        Ok(out) if out.status.success() => {
            let raw = tokio::fs::read_to_string(&output_file).await.unwrap_or_default();
            let _ = tokio::fs::remove_file(&output_file).await;
            parse_plan(&raw)
        }
        _ => {
            let _ = tokio::fs::remove_file(&output_file).await;
            tracing::warn!("[analyzer] Codex failed, using fallback plan");
            AnalysisPlan {
                needs_reply: true,
                summary: format!("Email von {} zu '{}'", headers.from_email, headers.subject),
                risk_flags: vec![],
                reply_brief: "Antwort erforderlich".into(),
                follow_up_questions: vec![],
            }
        }
    };

    Ok(plan)
}

fn parse_plan(raw: &str) -> AnalysisPlan {
    // Try direct parse
    if let Ok(plan) = serde_json::from_str::<AnalysisPlan>(raw) {
        return plan;
    }
    // Try extracting JSON from mixed output
    if let Some(start) = raw.find('{') {
        if let Ok(plan) = serde_json::from_str::<AnalysisPlan>(&raw[start..]) {
            return plan;
        }
    }
    // Fallback
    AnalysisPlan {
        needs_reply: true,
        summary: raw.chars().take(200).collect(),
        risk_flags: vec![],
        reply_brief: String::new(),
        follow_up_questions: vec![],
    }
}
