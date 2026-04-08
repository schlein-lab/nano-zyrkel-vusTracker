//! Literature Alert module — email-driven research paper aggregator.
//!
//! Two modes:
//!   poll  — Check IMAP inbox for new topic registrations (allowlist-gated)
//!   crawl — Search PubMed/bioRxiv/medRxiv/CrossRef + conference abstracts
//!
//! Structured sources (PubMed XML, bioRxiv JSON, CrossRef JSON) are parsed
//! deterministically. Unstructured sources (conference abstract books, program
//! pages) use Codex CLI for LLM-based extraction when available.

use anyhow::{Context, Result};
use crate::config::HatConfig;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Paper {
    source: String,
    pmid: String,
    title: String,
    authors: Vec<String>,
    journal: String,
    date: String,
    r#abstract: String,
    link: String,
    doi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Topics {
    #[serde(default)]
    topics: Vec<TopicEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TopicEntry {
    topic: String,
    requester: String,
    registered_at: String,
    #[serde(default = "default_true")]
    active: bool,
    #[serde(default)]
    last_digest_at: Option<String>,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Allowlist {
    #[serde(default)]
    allowed_addresses: Vec<String>,
    #[serde(default)]
    allowed_domains: Vec<String>,
    #[serde(default)]
    auto_approve: Option<AutoApprove>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AutoApprove {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    remaining_slots: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LitState {
    #[serde(default)]
    seen_hashes: Vec<String>,
    #[serde(default)]
    last_crawl: Option<String>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(config: &HatConfig, mode: &str, dry_run: bool, _lang: &str) -> Result<()> {
    let lit = config.literature.as_ref()
        .ok_or_else(|| anyhow::anyhow!("'literature' config section missing for LiteratureAlert"))?;

    tracing::info!(mode, "Literature Alert starting");

    match mode {
        "poll" => poll_inbox(config, lit, dry_run).await,
        "crawl" => crawl_and_digest(config, lit, dry_run).await,
        _ => {
            tracing::warn!("Unknown mode '{}', defaulting to poll", mode);
            poll_inbox(config, lit, dry_run).await
        }
    }
}

// ---------------------------------------------------------------------------
// IMAP POLL — register new topics
// ---------------------------------------------------------------------------

async fn poll_inbox(
    _config: &HatConfig,
    lit: &crate::config::LiteratureConfig,
    dry_run: bool,
) -> Result<()> {
    let smtp_user = std::env::var("SMTP_USER")
        .unwrap_or_else(|_| lit.mailbox.address.clone());
    let smtp_pass = std::env::var("SMTP_PASS")
        .map_err(|_| anyhow::anyhow!("SMTP_PASS not set"))?;

    let allowlist_file = if lit.bouncer.allowlist_file.is_empty() {
        "data/allowlist.json"
    } else {
        &lit.bouncer.allowlist_file
    };
    let topics_file = if lit.bouncer.topics_file.is_empty() {
        "data/topics.json"
    } else {
        &lit.bouncer.topics_file
    };

    let mut allowlist: Allowlist = load_json(allowlist_file).unwrap_or_default();
    let mut topics: Topics = load_json(topics_file).unwrap_or_default();
    let prefix = lit.bouncer.register_subject_prefix.to_lowercase();

    // Connect to IMAP
    let tls = native_tls::TlsConnector::new()?;
    let client = imap::connect(
        (&*lit.mailbox.imap_host, 993u16),
        &lit.mailbox.imap_host,
        &tls,
    ).context("IMAP connection failed")?;

    let mut session = client.login(&smtp_user, &smtp_pass)
        .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

    session.select("INBOX")?;

    let uids = session.uid_search("UNSEEN")?;
    if uids.is_empty() {
        tracing::info!("[poll] no new messages");
        session.logout().ok();
        return Ok(());
    }

    let mut allowlist_changed = false;
    let mut topics_changed = false;
    let allowed_addrs: HashSet<String> = allowlist.allowed_addresses.iter()
        .map(|a| a.to_lowercase()).collect();
    let allowed_domains: HashSet<String> = allowlist.allowed_domains.iter()
        .map(|d| d.to_lowercase()).collect();

    for uid in uids.iter() {
        let messages = session.uid_fetch(uid.to_string(), "RFC822")?;
        let msg = match messages.iter().next() {
            Some(m) => m,
            None => continue,
        };
        let body = match msg.body() {
            Some(b) => b,
            None => continue,
        };

        let parsed = match mailparse::parse_mail(body) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Failed to parse email: {}", e);
                continue;
            }
        };

        // Extract subject
        let subject = parsed.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("subject"))
            .map(|h| h.get_value())
            .unwrap_or_default();

        // Extract sender email
        let from_raw = parsed.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("from"))
            .map(|h| h.get_value())
            .unwrap_or_default();
        let sender = extract_email(&from_raw).to_lowercase();
        let sender_domain = sender.split('@').nth(1).unwrap_or("").to_string();

        if !subject.to_lowercase().starts_with(&prefix) {
            continue;
        }

        // Allowlist check
        let mut is_allowed = allowed_addrs.contains(&sender) || allowed_domains.contains(&sender_domain);

        // Auto-approve check
        if !is_allowed {
            if let Some(ref mut aa) = allowlist.auto_approve {
                if aa.enabled && !aa.domain.is_empty()
                    && sender_domain == aa.domain.to_lowercase()
                    && aa.remaining_slots > 0
                {
                    is_allowed = true;
                    allowlist.allowed_addresses.push(sender.clone());
                    aa.remaining_slots -= 1;
                    allowlist_changed = true;
                    tracing::info!("[poll] auto-approved {} ({} slots left)", sender, aa.remaining_slots);
                    send_telegram(&format!(
                        "✅ <b>Literature Alert — Auto-Approved</b>\n\
                         <code>{}</code> freigeschaltet\n\
                         Verbleibende Slots: {}",
                        sender, aa.remaining_slots
                    )).await;
                }
            }
        }

        if !is_allowed {
            tracing::info!("[poll] rejected {} — not on allowlist", sender);
            send_telegram(&format!(
                "⚠️ <b>Literature Alert</b>\n\
                 Abgelehnte Anfrage: <code>{}</code>\n\
                 Betreff: {}\n\
                 Nicht auf Allowlist.",
                sender, subject
            )).await;
            continue;
        }

        // Extract topic from body
        let body_text = parsed.subparts.iter()
            .find(|p| p.ctype.mimetype == "text/plain")
            .and_then(|p| p.get_body().ok())
            .or_else(|| parsed.get_body().ok())
            .unwrap_or_default();

        let mut topic_text = body_text.trim().to_string();
        if topic_text.is_empty() {
            // Fallback: subject minus prefix
            let after_prefix = &subject[prefix.len()..];
            topic_text = after_prefix.trim_start_matches(|c: char| c == ':' || c == '-' || c == ' ')
                .to_string();
        }
        if topic_text.is_empty() {
            continue;
        }

        // Deduplicate
        let already_exists = topics.topics.iter().any(|t|
            t.requester.to_lowercase() == sender && t.topic.to_lowercase() == topic_text.to_lowercase()
        );
        if already_exists {
            tracing::info!("[poll] duplicate topic from {}: {}", sender, topic_text);
            continue;
        }

        let entry = TopicEntry {
            topic: topic_text.clone(),
            requester: sender.clone(),
            registered_at: chrono::Utc::now().to_rfc3339(),
            active: true,
            last_digest_at: None,
        };
        topics.topics.push(entry);
        topics_changed = true;

        tracing::info!("[poll] new topic from {}: {}", sender, topic_text);

        send_telegram(&format!(
            "📚 <b>Literature Alert — Neues Topic</b>\n\
             Von: <code>{}</code>\n\
             Topic: <b>{}</b>",
            sender, topic_text
        )).await;

        // Confirmation email
        if !dry_run {
            send_html_email(
                &lit.mailbox,
                &sender,
                &format!("Literatur Recherche bestätigt: {}", topic_text),
                &format!(
                    "<p>Dein Thema <b>{}</b> wurde registriert.</p>\
                     <p>Du erhältst tägliche Updates, wenn neue Publikationen gefunden werden.</p>\
                     <p style='color:#888;font-size:12px;'>— Literature Alert (nano-zyrkel)</p>",
                    topic_text
                ),
            ).await.ok();
        }
    }

    session.logout().ok();

    if allowlist_changed {
        save_json(allowlist_file, &allowlist)?;
    }
    if topics_changed {
        save_json(topics_file, &topics)?;
    }

    tracing::info!("[poll] done");
    Ok(())
}

// ---------------------------------------------------------------------------
// CRAWL — search all sources, build HTML digests, send
// ---------------------------------------------------------------------------

async fn crawl_and_digest(
    config: &HatConfig,
    lit: &crate::config::LiteratureConfig,
    dry_run: bool,
) -> Result<()> {
    let topics_file = if lit.bouncer.topics_file.is_empty() {
        "data/topics.json"
    } else {
        &lit.bouncer.topics_file
    };
    let mut topics: Topics = load_json(topics_file).unwrap_or_default();
    let active_topics: Vec<&mut TopicEntry> = topics.topics.iter_mut()
        .filter(|t| t.active)
        .collect();

    if active_topics.is_empty() {
        tracing::info!("[crawl] no active topics");
        return Ok(());
    }

    let staging_dir = format!("{}/{}", config.output_dir, config.id);
    std::fs::create_dir_all(&staging_dir).ok();

    let mut state: LitState = load_json(&format!("{}/state.json", staging_dir)).unwrap_or_default();
    let mut seen: HashSet<String> = state.seen_hashes.iter().cloned().collect();
    let days_back = lit.days_back;
    let max_per_source = lit.max_results_per_source;
    let client = reqwest::Client::builder()
        .user_agent("nano-zyrkel-literature-alert/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let mut digests_sent = 0u32;

    for topic in active_topics {
        let query = &topic.topic;
        tracing::info!("[crawl] searching: {} (for {})", query, topic.requester);

        let mut all_papers: Vec<Paper> = Vec::new();

        if lit.sources.contains(&"pubmed".to_string()) {
            match search_pubmed(&client, query, days_back, max_per_source).await {
                Ok(papers) => all_papers.extend(papers),
                Err(e) => tracing::warn!("[pubmed] {}", e),
            }
        }
        if lit.sources.contains(&"biorxiv".to_string()) {
            match search_preprint(&client, "biorxiv", query, days_back, max_per_source).await {
                Ok(papers) => all_papers.extend(papers),
                Err(e) => tracing::warn!("[biorxiv] {}", e),
            }
        }
        if lit.sources.contains(&"medrxiv".to_string()) {
            match search_preprint(&client, "medrxiv", query, days_back, max_per_source).await {
                Ok(papers) => all_papers.extend(papers),
                Err(e) => tracing::warn!("[medrxiv] {}", e),
            }
        }
        if lit.sources.contains(&"crossref".to_string()) {
            match search_crossref(&client, query, days_back, max_per_source).await {
                Ok(papers) => all_papers.extend(papers),
                Err(e) => tracing::warn!("[crossref] {}", e),
            }
        }

        // TODO: Conference abstracts — LLM-based extraction via Codex (not yet implemented)

        // Dedup by content hash
        let mut new_papers: Vec<Paper> = Vec::new();
        for p in all_papers {
            let h = paper_hash(&p);
            if !seen.contains(&h) {
                seen.insert(h);
                new_papers.push(p);
            }
        }

        if new_papers.is_empty() {
            tracing::info!("[crawl] no new results for: {}", query);
            continue;
        }

        // Sort: PubMed first, then preprints, then conference/crossref
        new_papers.sort_by_key(|p| match p.source.as_str() {
            "PubMed" => 0,
            "bioRxiv" => 1,
            "medRxiv" => 2,
            "CrossRef" => 3,
            _ => 4, // Conference abstracts
        });

        tracing::info!("[crawl] {} new papers for '{}'", new_papers.len(), query);

        if !dry_run {
            let html = build_digest_html(query, &new_papers);
            send_html_email(
                &lit.mailbox,
                &topic.requester,
                &format!("Literature Alert: {} ({} neue Treffer)", query, new_papers.len()),
                &html,
            ).await?;
            digests_sent += 1;
        }

        topic.last_digest_at = Some(chrono::Utc::now().to_rfc3339());

        // Write latest.json for nano-manager ingestion
        let finding = serde_json::json!({
            "matched": true,
            "summary": format!("{} neue Papers fuer '{}': {}",
                new_papers.len(), query,
                new_papers.iter().take(3).map(|p| &p.title[..p.title.len().min(60)])
                    .collect::<Vec<_>>().join(", ")),
            "extracted_value": new_papers.len().to_string(),
            "content_hash": paper_hash(new_papers.first().unwrap_or(&Paper {
                source: String::new(), pmid: String::new(), title: query.clone(),
                authors: vec![], journal: String::new(), date: String::new(),
                r#abstract: String::new(), link: String::new(), doi: String::new(),
            })),
        });
        std::fs::write(
            format!("{}/latest.json", staging_dir),
            serde_json::to_string_pretty(&finding)?,
        )?;
    }

    // Persist state
    let seen_vec: Vec<String> = seen.into_iter().collect();
    let keep = seen_vec.len().saturating_sub(5000);
    state.seen_hashes = seen_vec.into_iter().skip(keep).collect();
    state.last_crawl = Some(chrono::Utc::now().to_rfc3339());
    save_json(&format!("{}/state.json", staging_dir), &state)?;

    save_json(
        if lit.bouncer.topics_file.is_empty() { "data/topics.json" } else { &lit.bouncer.topics_file },
        &topics,
    )?;

    if digests_sent > 0 {
        send_telegram(&format!("📚 Literature Alert: {} Digests versendet", digests_sent)).await;
    }

    tracing::info!("[crawl] done — {} digests sent", digests_sent);
    Ok(())
}

// ---------------------------------------------------------------------------
// PubMed E-utilities (structured XML, no LLM needed)
// ---------------------------------------------------------------------------

async fn search_pubmed(
    client: &reqwest::Client,
    query: &str,
    days_back: u32,
    max_results: u32,
) -> Result<Vec<Paper>> {
    let now = chrono::Utc::now();
    let min_date = (now - chrono::Duration::days(days_back as i64)).format("%Y/%m/%d");
    let max_date = now.format("%Y/%m/%d");

    // ESearch
    let search_url = format!(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?\
         db=pubmed&term={}&retmax={}&datetype=edat&mindate={}&maxdate={}&retmode=json&sort=date",
        urlencoding(query), max_results, min_date, max_date
    );
    let resp: serde_json::Value = client.get(&search_url).send().await?.json().await?;
    let ids: Vec<&str> = resp["esearchresult"]["idlist"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    if ids.is_empty() {
        return Ok(vec![]);
    }

    // EFetch XML
    let fetch_url = format!(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?\
         db=pubmed&id={}&retmode=xml",
        ids.join(",")
    );
    let xml = client.get(&fetch_url).send().await?.text().await?;

    Ok(parse_pubmed_xml(&xml))
}

/// Parse PubMed XML using regex — structured enough that full XML parsing is overkill.
fn parse_pubmed_xml(xml: &str) -> Vec<Paper> {
    let article_re = regex::Regex::new(r"(?s)<PubmedArticle>(.*?)</PubmedArticle>").unwrap();
    let pmid_re = regex::Regex::new(r"<PMID[^>]*>(\d+)</PMID>").unwrap();
    let title_re = regex::Regex::new(r"(?s)<ArticleTitle>(.*?)</ArticleTitle>").unwrap();
    let journal_re = regex::Regex::new(r"<ISOAbbreviation>(.*?)</ISOAbbreviation>").unwrap();
    let author_re = regex::Regex::new(r"(?s)<Author[^>]*>.*?<LastName>(.*?)</LastName>.*?(?:<ForeName>(.*?)</ForeName>)?.*?</Author>").unwrap();
    let abstract_re = regex::Regex::new(r"(?s)<AbstractText[^>]*>(.*?)</AbstractText>").unwrap();
    let year_re = regex::Regex::new(r"<Year>(\d{4})</Year>").unwrap();
    let month_re = regex::Regex::new(r"<Month>([^<]+)</Month>").unwrap();

    let mut papers = Vec::new();

    for cap in article_re.captures_iter(xml) {
        let block = &cap[1];

        let pmid = pmid_re.captures(block)
            .map(|c| c[1].to_string()).unwrap_or_default();
        let title = title_re.captures(block)
            .map(|c| strip_xml_tags(&c[1])).unwrap_or_default();
        let journal = journal_re.captures(block)
            .map(|c| c[1].to_string()).unwrap_or_default();

        let mut authors: Vec<String> = Vec::new();
        for a in author_re.captures_iter(block) {
            let last = &a[1];
            let fore = a.get(2).map(|m| m.as_str()).unwrap_or("");
            authors.push(format!("{} {}", last, fore).trim().to_string());
        }

        let abstract_parts: Vec<String> = abstract_re.captures_iter(block)
            .map(|c| strip_xml_tags(&c[1]))
            .collect();
        let abstract_text = abstract_parts.join(" ");

        let year = year_re.captures(block).map(|c| c[1].to_string()).unwrap_or_default();
        let month = month_re.captures(block).map(|c| c[1].to_string()).unwrap_or_default();
        let date = format!("{} {}", year, month).trim().to_string();

        papers.push(Paper {
            source: "PubMed".into(),
            pmid: pmid.clone(),
            title,
            authors,
            journal,
            date,
            r#abstract: abstract_text,
            link: format!("https://pubmed.ncbi.nlm.nih.gov/{}/", pmid),
            doi: String::new(),
        });
    }

    papers
}

// ---------------------------------------------------------------------------
// bioRxiv / medRxiv API (JSON, no LLM needed)
// ---------------------------------------------------------------------------

async fn search_preprint(
    client: &reqwest::Client,
    server: &str,
    query: &str,
    days_back: u32,
    max_results: u32,
) -> Result<Vec<Paper>> {
    let now = chrono::Utc::now();
    let start = (now - chrono::Duration::days(days_back as i64)).format("%Y-%m-%d");
    let end = now.format("%Y-%m-%d");

    let url = format!(
        "https://api.biorxiv.org/details/{}/{}/{}/0/{}",
        server, start, end, max_results
    );
    let resp: serde_json::Value = client.get(&url).send().await?.json().await?;

    let query_terms: Vec<String> = query.to_lowercase().split_whitespace()
        .map(|s| s.to_string()).collect();

    let mut papers = Vec::new();
    if let Some(items) = resp["collection"].as_array() {
        for item in items {
            let title = item["title"].as_str().unwrap_or("");
            let abstract_text = item["abstract"].as_str().unwrap_or("");
            let blob = format!("{} {}", title, abstract_text).to_lowercase();

            // Keyword match (API doesn't support full-text search)
            if !query_terms.iter().any(|t| blob.contains(t.as_str())) {
                continue;
            }

            let doi = item["doi"].as_str().unwrap_or("").to_string();
            let authors_raw = item["authors"].as_str().unwrap_or("");
            let authors: Vec<String> = authors_raw.split(';')
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();

            papers.push(Paper {
                source: capitalize(server),
                pmid: String::new(),
                title: title.to_string(),
                authors,
                journal: format!("{} (preprint)", server),
                date: item["date"].as_str().unwrap_or("").to_string(),
                r#abstract: abstract_text.to_string(),
                link: if doi.is_empty() { String::new() } else { format!("https://doi.org/{}", doi) },
                doi,
            });
        }
    }

    Ok(papers)
}

// ---------------------------------------------------------------------------
// CrossRef API (conference proceedings, JSON, no LLM needed)
// ---------------------------------------------------------------------------

async fn search_crossref(
    client: &reqwest::Client,
    query: &str,
    days_back: u32,
    max_results: u32,
) -> Result<Vec<Paper>> {
    let from_date = (chrono::Utc::now() - chrono::Duration::days(days_back as i64))
        .format("%Y-%m-%d").to_string();

    let url = format!(
        "https://api.crossref.org/works?query={}&filter=from-created-date:{},type:proceedings-article\
         &rows={}&sort=created&order=desc",
        urlencoding(query), from_date, max_results
    );
    let resp: serde_json::Value = client.get(&url).send().await?.json().await?;

    let mut papers = Vec::new();
    if let Some(items) = resp["message"]["items"].as_array() {
        for item in items {
            let title = item["title"].as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let doi = item["DOI"].as_str().unwrap_or("").to_string();

            let mut authors: Vec<String> = Vec::new();
            if let Some(auths) = item["author"].as_array() {
                for a in auths {
                    let name = format!("{} {}",
                        a["family"].as_str().unwrap_or(""),
                        a["given"].as_str().unwrap_or("")
                    ).trim().to_string();
                    if !name.is_empty() { authors.push(name); }
                }
            }

            let container = item["container-title"].as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("Conference")
                .to_string();

            let date_parts = item["created"]["date-parts"].as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_array());
            let date = date_parts.map(|parts|
                parts.iter().filter_map(|p| p.as_i64()).map(|p| p.to_string())
                    .collect::<Vec<_>>().join("-")
            ).unwrap_or_default();

            papers.push(Paper {
                source: "CrossRef".into(),
                pmid: String::new(),
                title,
                authors,
                journal: container,
                date,
                r#abstract: String::new(),
                link: if doi.is_empty() { String::new() } else { format!("https://doi.org/{}", doi) },
                doi,
            });
        }
    }

    Ok(papers)
}

// ---------------------------------------------------------------------------
// Conference Abstracts (LLM-based extraction via Codex CLI)
// ---------------------------------------------------------------------------

async fn search_conference(
    client: &reqwest::Client,
    conf: &crate::config::ConferenceSource,
    query: &str,
    max_results: u32,
) -> Result<Vec<Paper>> {
    // 1. Fetch the page
    let html = client.get(&conf.url).send().await?.text().await?;

    // 2. Optional: narrow with CSS selector
    let content = if let Some(ref sel) = conf.selector {
        let document = scraper::Html::parse_document(&html);
        match scraper::Selector::parse(sel) {
            Ok(selector) => {
                document.select(&selector)
                    .map(|el| el.text().collect::<Vec<_>>().join(" "))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            }
            Err(_) => {
                tracing::warn!("[conference:{}] invalid selector '{}', using full page", conf.name, sel);
                strip_html_to_text(&html)
            }
        }
    } else {
        strip_html_to_text(&html)
    };

    if content.trim().is_empty() {
        return Ok(vec![]);
    }

    // 3. Truncate to ~12k chars for LLM context
    let max_chars = 12000;
    let truncated = if content.len() > max_chars {
        &content[..max_chars]
    } else {
        &content
    };

    // 4. Build prompt for Codex — extract abstracts matching the query
    let prompt = format!(
        "Du bist ein wissenschaftlicher Literatur-Analyst.\n\
         Durchsuche den folgenden Text von der Konferenz '{conf_name}' nach Abstracts \
         die relevant sind fuer das Thema: \"{query}\"\n\n\
         Fuer JEDEN relevanten Abstract, extrahiere:\n\
         - title: Titel des Abstracts\n\
         - authors: Autorenliste (Array von Strings)\n\
         - abstract: Kerninhalt (max 300 Zeichen)\n\
         - id: Abstract-Nummer falls vorhanden\n\n\
         Antworte NUR mit JSON-Array. Keine Erklaerung. Max {max} Eintraege.\n\
         Falls nichts relevant: antworte mit []\n\n\
         TEXT:\n{text}",
        conf_name = conf.name,
        query = query,
        max = max_results,
        text = truncated,
    );

    // 5. Call Codex CLI (reuse pattern from condition.rs)
    let answer = match call_codex_for_literature(&prompt).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("[conference:{}] Codex unavailable: {}", conf.name, e);
            return Ok(vec![]);
        }
    };

    // 6. Parse JSON response into Papers
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&answer)
        .or_else(|_| {
            // Try to extract JSON array from response (Codex sometimes wraps in markdown)
            let start = answer.find('[').unwrap_or(0);
            let end = answer.rfind(']').map(|i| i + 1).unwrap_or(answer.len());
            serde_json::from_str(&answer[start..end])
        })
        .unwrap_or_default();

    let papers: Vec<Paper> = parsed.iter().filter_map(|item| {
        let title = item["title"].as_str()?.to_string();
        if title.is_empty() { return None; }

        let authors: Vec<String> = item["authors"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let abstract_text = item["abstract"].as_str().unwrap_or("").to_string();
        let abstract_id = item["id"].as_str().unwrap_or("").to_string();

        Some(Paper {
            source: format!("Conference: {}", conf.name),
            pmid: String::new(),
            title,
            authors,
            journal: conf.name.clone(),
            date: String::new(),
            r#abstract: abstract_text,
            link: if abstract_id.is_empty() {
                conf.url.clone()
            } else {
                format!("{}#{}", conf.url, abstract_id)
            },
            doi: String::new(),
        })
    }).collect();

    Ok(papers)
}

/// Call Codex CLI for literature extraction.
/// Falls back gracefully — conference abstracts are optional.
async fn call_codex_for_literature(prompt: &str) -> Result<String> {
    // Check if codex is available
    let check = tokio::process::Command::new("codex")
        .arg("--version")
        .output()
        .await;

    if check.is_err() || !check.unwrap().status.success() {
        anyhow::bail!("Codex CLI not available");
    }

    let output_file = format!("/tmp/nano-zyrkel-lit-{}.txt", std::process::id());

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new("codex")
            .args([
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "-o", &output_file,
                prompt,
            ])
            .output(),
    )
    .await
    .context("Codex CLI timeout after 120s")?
    .context("Codex CLI execution failed")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("Codex error: {}", stderr.chars().take(200).collect::<String>());
    }

    let answer = tokio::fs::read_to_string(&output_file).await
        .context("Failed to read Codex output")?;
    let _ = tokio::fs::remove_file(&output_file).await;

    Ok(answer.trim().to_string())
}

/// Strip HTML tags and collapse whitespace for LLM input.
fn strip_html_to_text(html: &str) -> String {
    let document = scraper::Html::parse_document(html);
    let body_sel = scraper::Selector::parse("body").unwrap();
    document.select(&body_sel)
        .next()
        .map(|el| el.text().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// HTML Digest Builder
// ---------------------------------------------------------------------------

fn build_digest_html(topic: &str, papers: &[Paper]) -> String {
    let mut rows = String::new();

    for p in papers {
        let id_badge = if !p.pmid.is_empty() {
            format!("<span style='color:#666;'>PMID: <a href='{}'>{}</a></span>", p.link, p.pmid)
        } else if !p.doi.is_empty() {
            format!("<span style='color:#666;'>DOI: <a href='{}'>{}</a></span>", p.link, p.doi)
        } else if !p.link.is_empty() {
            format!("<a href='{}'>Link</a>", p.link)
        } else {
            String::new()
        };

        // Truncate abstract at sentence boundary ~350 chars
        let abs = &p.r#abstract;
        let truncated = if abs.len() > 400 {
            let cut_point = abs[..400].rfind('.')
                .filter(|&i| i > 200)
                .unwrap_or(400);
            format!("{}…", &abs[..cut_point])
        } else {
            abs.clone()
        };

        let authors_str = if p.authors.len() > 6 {
            format!("{} et al. ({})", p.authors[..6].join(", "), p.authors.len())
        } else {
            p.authors.join(", ")
        };

        rows.push_str(&format!(
            "<tr><td style='padding:12px 0;border-bottom:1px solid #eee;'>\
             <div style='font-weight:600;font-size:14px;margin-bottom:4px;'>{title}</div>\
             <div style='font-size:12px;color:#555;margin-bottom:4px;'>{authors}</div>\
             <div style='font-size:12px;margin-bottom:4px;'>\
               <span style='background:#f0f0f0;padding:2px 6px;border-radius:3px;'>{source}</span>\
               <span style='margin-left:8px;'>{journal}</span>\
               <span style='margin-left:8px;color:#888;'>{date}</span>\
             </div>\
             <div style='font-size:13px;color:#333;margin:6px 0;'>{abs}</div>\
             <div style='font-size:12px;'>{badge}</div>\
             </td></tr>",
            title = p.title,
            authors = authors_str,
            source = p.source,
            journal = p.journal,
            date = p.date,
            abs = truncated,
            badge = id_badge,
        ));
    }

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");

    format!(
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>\
         <body style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;\
         max-width:700px;margin:0 auto;padding:20px;color:#222;'>\
         <h2 style='margin:0 0 4px;'>Literature Alert: {topic}</h2>\
         <p style='color:#888;margin:0 0 16px;font-size:13px;'>{count} neue Ergebnisse — {now}</p>\
         <table style='width:100%;border-collapse:collapse;'>{rows}</table>\
         <p style='color:#aaa;font-size:11px;margin-top:24px;border-top:1px solid #eee;\
         padding-top:12px;'>nano-zyrkel literature-alert — automatischer Digest</p>\
         </body></html>",
        topic = topic,
        count = papers.len(),
        now = now,
        rows = rows,
    )
}

// ---------------------------------------------------------------------------
// Email send (SMTP via lettre)
// ---------------------------------------------------------------------------

async fn send_html_email(
    mailbox: &crate::config::LiteratureMailbox,
    to: &str,
    subject: &str,
    html_body: &str,
) -> Result<()> {
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::message::{Message, SinglePart, header::ContentType};

    let from_addr = std::env::var("SMTP_USER")
        .unwrap_or_else(|_| mailbox.address.clone());
    let pass = std::env::var("SMTP_PASS")
        .map_err(|_| anyhow::anyhow!("SMTP_PASS not set"))?;

    let from_formatted = format!("{} <{}>", mailbox.reply_name, from_addr);

    let email = Message::builder()
        .from(from_formatted.parse()?)
        .to(to.parse()?)
        .subject(subject)
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html_body.to_string()),
        )?;

    let creds = Credentials::new(from_addr, pass);
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&mailbox.smtp_host)?
        .credentials(creds)
        .build();

    mailer.send(email).await?;
    tracing::info!("[smtp] sent to {}: {}", to, subject);
    Ok(())
}

// ---------------------------------------------------------------------------
// Telegram (reuse pattern from notify.rs)
// ---------------------------------------------------------------------------

async fn send_telegram(msg: &str) {
    let token = match std::env::var("TELEGRAM_BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => return,
    };
    let chat_id = match std::env::var("TELEGRAM_CHAT_ID") {
        Ok(c) => c,
        Err(_) => return,
    };

    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    let _ = client.post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "HTML",
        }))
        .send()
        .await;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn load_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T> {
    let data = std::fs::read_to_string(path)
        .with_context(|| format!("Cannot read {}", path))?;
    serde_json::from_str(&data)
        .with_context(|| format!("Cannot parse {}", path))
}

fn save_json<T: serde::Serialize>(path: &str, data: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(data)?;
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, json)?;
    Ok(())
}

fn paper_hash(p: &Paper) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{}|{}", p.title, p.doi, p.pmid).as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn extract_email(from: &str) -> String {
    let re = regex::Regex::new(r"[\w.+-]+@[\w.-]+").unwrap();
    re.find(from).map(|m| m.as_str().to_string()).unwrap_or_default()
}

fn strip_xml_tags(s: &str) -> String {
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    re.replace_all(s, "").trim().to_string()
}

fn urlencoding(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        ' ' => "+".to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}
