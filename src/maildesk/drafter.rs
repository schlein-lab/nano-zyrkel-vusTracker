//! Reply drafter — uses Codex CLI to compose professional email replies.
//! Drafts are plain text (HTML rendering happens in sender module).

use anyhow::Result;
use super::imap_client::EmailHeaders;
use super::analyzer::AnalysisPlan;
use crate::config::MaildeskConfig;

/// Draft a professional reply using Codex CLI.
pub async fn draft_reply(
    headers: &EmailHeaders,
    plan: &AnalysisPlan,
    config: &MaildeskConfig,
) -> Result<String> {
    let prompt = format!(
        "Du schreibst eine Antwort-Email im Namen von {}, {}.\n\n\
         EINGEHENDE MAIL:\n\
         Von: {}\n\
         Betreff: {}\n\
         Zusammenfassung: {}\n\n\
         ANTWORT-KERNPUNKT: {}\n\n\
         REGELN:\n\
         - Schreibe auf Deutsch, professionell, freundlich, praezise.\n\
         - Beginne mit passender Anrede.\n\
         - Ende mit \"Mit freundlichen Gruessen\" (Signatur wird automatisch angehaengt).\n\
         - Erfinde KEINE Fakten, Termine, Zusagen.\n\
         - Falls Infos fehlen: hoefliche Rueckfrage.\n\
         - NUR reiner Mailtext — kein Betreff, kein Markdown.\n\
         - Maximal 10 Saetze.",
        config.sig_name, config.sig_role,
        headers.from_raw, headers.subject,
        plan.summary, plan.reply_brief,
    );

    let output_file = format!("/tmp/nano-draft-{}.txt", std::process::id());

    let status = tokio::process::Command::new("codex")
        .args(["exec", "--skip-git-repo-check", "--ephemeral", "-o", &output_file])
        .arg(&prompt)
        .output()
        .await;

    let draft = match status {
        Ok(out) if out.status.success() => {
            tokio::fs::read_to_string(&output_file).await.unwrap_or_default()
        }
        _ => {
            format!(
                "Sehr geehrte Damen und Herren,\n\n\
                 vielen Dank fuer Ihre Nachricht.\n\
                 Ich melde mich zeitnah bei Ihnen.\n\n\
                 Mit freundlichen Gruessen"
            )
        }
    };

    let _ = tokio::fs::remove_file(&output_file).await;
    Ok(draft.trim().to_string())
}

/// Re-draft with additional instruction.
pub async fn redraft(
    headers: &EmailHeaders,
    plan: &AnalysisPlan,
    config: &MaildeskConfig,
    instruction: &str,
) -> Result<String> {
    // Modify plan with instruction hint
    let mut modified_plan = plan.clone();
    modified_plan.reply_brief = format!("{} (Hinweis: {})", plan.reply_brief, instruction);
    draft_reply(headers, &modified_plan, config).await
}
