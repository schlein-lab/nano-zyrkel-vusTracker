//! Email sender — renders reply into HTML and sends via SMTP.
//! Uses `lettre` for SMTP (async, rustls-tls, no OpenSSL).

use anyhow::Result;
use super::Case;
use crate::config::MaildeskConfig;

/// Send a reply email for a case.
pub async fn send_reply(
    case: &Case,
    draft: &str,
    smtp_user: &str,
    smtp_pass: &str,
    config: &MaildeskConfig,
) -> Result<()> {
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::message::{Message, SinglePart, header::ContentType};

    let html_body = render_html(case, draft, config);

    let email = Message::builder()
        .from(format!("{} <{}>", config.reply_name, smtp_user).parse()?)
        .to(case.from_email.parse()?)
        .subject(format!("Re: {}", case.subject))
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html_body)
        )?;

    let creds = Credentials::new(smtp_user.to_string(), smtp_pass.to_string());
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)?
        .credentials(creds)
        .build();

    mailer.send(email).await?;
    tracing::info!("[sender] Reply sent to {}", case.from_email);
    Ok(())
}

/// Render draft text into a professional HTML email.
fn render_html(case: &Case, draft: &str, config: &MaildeskConfig) -> String {
    // Convert plain text to HTML paragraphs
    let body_html: String = draft.lines()
        .collect::<Vec<_>>()
        .split(|l| l.trim().is_empty())
        .map(|group| {
            let para: String = group.iter()
                .map(|l| html_escape(l))
                .collect::<Vec<_>>()
                .join("<br>");
            format!("<p style=\"margin:0 0 16px 0;\">{}</p>", para)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let from_email = html_escape(&case.from_email);

    format!(
        r#"<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#ffffff; color:#222222; font-family:Georgia, 'Times New Roman', serif;">

  <!-- Main container -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px; width:100%;">

          <!-- Body -->
          <tr>
            <td style="padding:0 0 32px 0; font-size:15px; line-height:1.8; color:#222222;">
              {body}
            </td>
          </tr>

          <!-- Signature -->
          <tr>
            <td style="padding:24px 0 0 0; border-top:1px solid #e5e5e5;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding-right:16px; vertical-align:top;">
                    <div style="width:3px; height:48px; background:#0d9488; border-radius:2px;"></div>
                  </td>
                  <td style="vertical-align:top;">
                    <div style="font-family:'Segoe UI', Arial, sans-serif; font-size:14px; font-weight:600; color:#1a1a1a; line-height:1.4;">
                      {sig_name}
                    </div>
                    <div style="font-family:'Segoe UI', Arial, sans-serif; font-size:12px; color:#666666; line-height:1.5; margin-top:2px;">
                      {sig_role}<br>
                      Institute of Human Genetics<br>
                      University Medical Center Hamburg-Eppendorf (UKE)
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Quick Response (subtle, links to repo feedback endpoint) -->
          <tr>
            <td style="padding:28px 0 0 0;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding-right:12px;">
                    <a href="https://github.com/schlein-lab/nano-zyrkel-maildesk/issues/new?title=feedback:{case_id}:done&amp;body=Erledigt"
                       style="font-family:'Segoe UI',Arial,sans-serif; font-size:11px; color:#0d9488; text-decoration:none; border:1px solid #d1d5db; border-radius:4px; padding:5px 12px; display:inline-block;">
                      &#10003; Erledigt
                    </a>
                  </td>
                  <td style="padding-right:12px;">
                    <a href="https://github.com/schlein-lab/nano-zyrkel-maildesk/issues/new?title=feedback:{case_id}:callback&amp;body=Bitte um Rueckruf"
                       style="font-family:'Segoe UI',Arial,sans-serif; font-size:11px; color:#0d9488; text-decoration:none; border:1px solid #d1d5db; border-radius:4px; padding:5px 12px; display:inline-block;">
                      &#9742; R&uuml;ckruf
                    </a>
                  </td>
                  <td>
                    <a href="mailto:{from_email}?subject=Re: {subject}"
                       style="font-family:'Segoe UI',Arial,sans-serif; font-size:11px; color:#0d9488; text-decoration:none; border:1px solid #d1d5db; border-radius:4px; padding:5px 12px; display:inline-block;">
                      &#9993; Antworten
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:32px 0 0 0;">
              <p style="font-family:'Segoe UI',Arial,sans-serif; font-size:10px; color:#aaaaaa; line-height:1.6; margin:0;">
                Autonomously drafted &middot; reviewed &amp; approved before dispatch<br>
                <a href="https://zyrkel.com" style="color:#aaaaaa; text-decoration:none;">zyrkel.com</a>
                &middot;
                <a href="https://www.uke.de/kliniken-institute/institute/humangenetik/" style="color:#aaaaaa; text-decoration:none;">UKE Human Genetics</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>"#,
        body = body_html,
        from_email = from_email,
        subject = html_escape(&case.subject),
        sig_name = html_escape(&config.sig_name),
        sig_role = html_escape(&config.sig_role),
        case_id = html_escape(&case.id),
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
