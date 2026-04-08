//! IMAP client — fetch unread emails from Gmail.
//! Uses the `imap` crate (sync) wrapped in tokio::task::spawn_blocking.

use anyhow::{Context, Result};

/// Parsed email headers.
pub struct EmailHeaders {
    pub from_raw: String,
    pub from_email: String,
    pub subject: String,
}

/// Fetch UIDs of all UNSEEN messages via IMAP.
pub async fn fetch_unseen(host: &str, user: &str, pass: &str) -> Result<Vec<String>> {
    let host = host.to_string();
    let user = user.to_string();
    let pass = pass.to_string();

    tokio::task::spawn_blocking(move || {
        let tls = native_tls::TlsConnector::new()?;
        let client = imap::connect((&*host, 993), &host, &tls)?;
        let mut session = client.login(&user, &pass)
            .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

        session.select("INBOX")?;
        let uids = session.search("UNSEEN")?;
        let result: Vec<String> = uids.iter().map(|u| u.to_string()).collect();

        session.logout()?;
        Ok(result)
    })
    .await?
}

/// Download a single email by UID.
pub async fn fetch_email(host: &str, user: &str, pass: &str, uid: &str, output_path: &str) -> Result<()> {
    let host = host.to_string();
    let user = user.to_string();
    let pass = pass.to_string();
    let uid: u32 = uid.parse()?;
    let output = output_path.to_string();

    tokio::task::spawn_blocking(move || {
        let tls = native_tls::TlsConnector::new()?;
        let client = imap::connect((&*host, 993), &host, &tls)?;
        let mut session = client.login(&user, &pass)
            .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

        session.select("INBOX")?;
        let messages = session.fetch(uid.to_string(), "RFC822")?;

        for msg in messages.iter() {
            if let Some(body) = msg.body() {
                std::fs::write(&output, body)?;
            }
        }

        session.logout()?;
        Ok(())
    })
    .await?
}

/// Parse From + Subject headers from a .eml file.
pub fn parse_headers(eml_path: &str) -> Result<EmailHeaders> {
    let content = std::fs::read_to_string(eml_path)
        .with_context(|| format!("Cannot read {}", eml_path))?;

    let from_raw = extract_header(&content, "From");
    let subject = extract_header(&content, "Subject");
    let from_email = extract_email(&from_raw);

    Ok(EmailHeaders {
        from_raw,
        from_email,
        subject,
    })
}

/// Extract clean body text from a .eml file.
/// Strips MIME headers, HTML tags, base64 encoding.
pub fn extract_body_text(eml_path: &str, max_chars: usize) -> Result<String> {
    let content = std::fs::read_to_string(eml_path)?;

    // Find body (after first empty line)
    let body_start = content.find("\r\n\r\n")
        .or_else(|| content.find("\n\n"))
        .map(|i| i + 2)
        .unwrap_or(0);

    let raw_body = &content[body_start..];

    // Strip HTML tags
    let text = regex::Regex::new(r"<[^>]*>").unwrap()
        .replace_all(raw_body, " ");

    // Decode common entities
    let text = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    // Strip MIME boundaries and content headers
    let lines: Vec<&str> = text.lines()
        .filter(|l| !l.starts_with("--"))
        .filter(|l| !l.starts_with("Content-"))
        .filter(|l| !l.starts_with("MIME-"))
        .filter(|l| !l.trim().is_empty())
        .collect();

    let clean = lines.join("\n");
    let truncated = if clean.len() > max_chars {
        &clean[..max_chars]
    } else {
        &clean
    };

    Ok(truncated.to_string())
}

fn extract_header(content: &str, name: &str) -> String {
    let prefix = format!("{}:", name);
    for line in content.lines() {
        if line.to_lowercase().starts_with(&prefix.to_lowercase()) {
            return line[prefix.len()..].trim().to_string();
        }
        // Empty line = end of headers
        if line.trim().is_empty() {
            break;
        }
    }
    String::new()
}

fn extract_email(from: &str) -> String {
    let re = regex::Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap();
    re.find(from)
        .map(|m| m.as_str().to_lowercase())
        .unwrap_or_else(|| from.to_lowercase())
}
