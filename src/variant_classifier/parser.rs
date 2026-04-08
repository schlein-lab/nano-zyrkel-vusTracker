//! Variant parsing & normalization.
//!
//! Fast path: regex for unambiguous HGVS, genomic coords, rsIDs.
//! Slow path: Codex CLI for messy/incomplete input (gene+shorthand, wrong nomenclature, etc.)

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// Parsed & normalized variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// How it was parsed
    pub format: VariantFormat,
    /// Best human-readable representation
    pub display_name: String,
    /// Best query string for myvariant.info
    pub query: String,
    /// Original input text
    pub raw_input: String,
    /// Gene symbol (if known)
    pub gene: Option<String>,
    /// RefSeq transcript (if resolved)
    pub transcript: Option<String>,
    /// HGVS coding change
    pub hgvs_c: Option<String>,
    /// HGVS protein change
    pub hgvs_p: Option<String>,
    /// Genomic representation
    pub genomic: Option<String>,
    /// rsID
    pub rsid: Option<String>,
    /// Genome build
    pub build: String,
    /// Whether build was assumed (not explicitly stated)
    pub build_assumed: bool,
    /// Corrections applied during normalization
    pub corrections: Vec<String>,
    /// Confidence level
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariantFormat {
    Hgvs,
    Genomic,
    Rsid,
    LlmNormalized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

// -- Regexes (compiled once) --

static RE_HGVS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(NM_\d+(?:\.\d+)?):([cgp])\.(\S+)").unwrap()
});

static RE_GENOMIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)chr(\d+|[XYM])[\s:\-_]+(\d+)[\s:\-_]+([ACGT]+)[\s:\-_>\/]+([ACGT]+)").unwrap()
});

static RE_GENOMIC_HGVS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)chr(\d+|[XYM]):g\.(\d+)([ACGT]+)>([ACGT]+)").unwrap()
});

static RE_RSID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(rs\d+)").unwrap()
});

/// Parse a variant from free text. Tries fast regex first, then Codex LLM.
pub async fn parse(text: &str) -> Result<Option<Variant>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }

    // 1. Full HGVS with transcript
    if let Some(caps) = RE_HGVS.captures(text) {
        let transcript = caps[1].to_string();
        let vtype = caps[2].to_lowercase();
        let change = caps[3].to_string();
        let raw = format!("{}:{}.{}", transcript, vtype, change);
        return Ok(Some(Variant {
            format: VariantFormat::Hgvs,
            display_name: raw.clone(),
            query: raw.clone(),
            raw_input: text.to_string(),
            gene: None,
            transcript: Some(transcript),
            hgvs_c: if vtype == "c" { Some(format!("c.{}", change)) } else { None },
            hgvs_p: if vtype == "p" { Some(format!("p.{}", change)) } else { None },
            genomic: None,
            rsid: None,
            build: "hg38".into(),
            build_assumed: false,
            corrections: vec![],
            confidence: Confidence::High,
        }));
    }

    // 2. Genomic HGVS (chr7:g.117559590A>G)
    if let Some(caps) = RE_GENOMIC_HGVS.captures(text) {
        let (chrom, pos, r, a) = (&caps[1], &caps[2], &caps[3], &caps[4]);
        let raw = format!("chr{}:g.{}{}>{}",chrom, pos, r.to_uppercase(), a.to_uppercase());
        return Ok(Some(Variant {
            format: VariantFormat::Genomic,
            display_name: raw.clone(),
            query: raw.clone(),
            raw_input: text.to_string(),
            gene: None, transcript: None, hgvs_c: None, hgvs_p: None,
            genomic: Some(raw.clone()),
            rsid: None,
            build: "hg38".into(), build_assumed: true,
            corrections: vec![], confidence: Confidence::High,
        }));
    }

    // 3. Genomic with flexible separators
    if let Some(caps) = RE_GENOMIC.captures(text) {
        let (chrom, pos, r, a) = (&caps[1], &caps[2], &caps[3], &caps[4]);
        let raw = format!("chr{}:g.{}{}>{}",chrom, pos, r.to_uppercase(), a.to_uppercase());
        return Ok(Some(Variant {
            format: VariantFormat::Genomic,
            display_name: raw.clone(),
            query: raw.clone(),
            raw_input: text.to_string(),
            gene: None, transcript: None, hgvs_c: None, hgvs_p: None,
            genomic: Some(raw.clone()),
            rsid: None,
            build: "hg38".into(), build_assumed: true,
            corrections: vec![], confidence: Confidence::High,
        }));
    }

    // 4. rsID
    if let Some(caps) = RE_RSID.captures(text) {
        let rsid = caps[1].to_lowercase();
        return Ok(Some(Variant {
            format: VariantFormat::Rsid,
            display_name: rsid.clone(),
            query: rsid.clone(),
            raw_input: text.to_string(),
            gene: None, transcript: None, hgvs_c: None, hgvs_p: None,
            genomic: None,
            rsid: Some(rsid),
            build: "hg38".into(), build_assumed: false,
            corrections: vec![], confidence: Confidence::High,
        }));
    }

    // 5. Slow path: Codex LLM normalization
    tracing::info!("[parser] no regex match, calling Codex for: {}", &text[..text.len().min(100)]);
    codex_normalize(text).await
}

/// Extract context (notes after the variant) from full input text.
pub fn extract_context(text: &str, variant: &Variant) -> String {
    // Codex may have extracted context already via corrections/notes
    let raw = &variant.raw_input;

    let idx = text.find(&variant.display_name)
        .or_else(|| text.find(raw.as_str()))
        .unwrap_or(0);

    let after = if idx > 0 {
        &text[idx + variant.display_name.len().max(raw.len()).min(text.len() - idx)..]
    } else {
        ""
    };

    let cleaned = after
        .trim_start_matches(|c: char| c == ',' || c == ';' || c == ':' || c == '-' || c.is_whitespace());

    // Stop at email signatures
    let stop_markers = ["--", "___", "Gesendet von", "Sent from", "Mit freundlichen"];
    let mut result = cleaned.to_string();
    for marker in stop_markers {
        if let Some(pos) = result.find(marker) {
            result.truncate(pos);
        }
    }

    result.trim().chars().take(500).collect()
}

// ---------------------------------------------------------------------------
// Codex LLM normalization
// ---------------------------------------------------------------------------

const NORMALIZE_PROMPT: &str = r#"Du bist ein Humangenetik-Experte. Extrahiere und normalisiere die Variante aus dem folgenden Text.

REGELN:
- Gib IMMER eine strukturierte JSON-Antwort zurueck, nichts anderes
- Loesche den HGVS-Ausdruck vollstaendig auf (Gen → MANE Select Transkript, 1-Buchstaben-AS → 3-Buchstaben)
- Wenn nur ein Genname + Kurzform gegeben ist (z.B. "TP53 R248W"), wandle in p.Arg248Trp um und suche das MANE Select Transkript
- Wenn nur c. gegeben ist, versuche p. abzuleiten
- Wenn genomische Koordinaten ohne Build angegeben: nimm hg38 an, flag aber "build_assumed": true
- Wenn die Nomenklatur fehlerhaft ist: korrigiere sie, notiere den Fehler in "corrections"

JSON-Format:
{"gene": "SYMBOL oder null", "transcript": "NM_... oder null", "hgvs_c": "c.247G>A oder null", "hgvs_p": "p.Arg248Trp oder null", "genomic": "chr7:g.117559590A>G oder null", "rsid": "rs12345 oder null", "build": "hg38 oder hg19", "build_assumed": true/false, "classification_query": "bester Query-String fuer myvariant.info", "display_name": "kurzer lesbarer Name z.B. TP53 p.Arg248Trp", "corrections": [], "confidence": "high/medium/low", "error": null}

TEXT:
"#;

/// Codex response structure.
#[derive(Debug, Deserialize)]
struct CodexResponse {
    gene: Option<String>,
    transcript: Option<String>,
    hgvs_c: Option<String>,
    hgvs_p: Option<String>,
    genomic: Option<String>,
    rsid: Option<String>,
    #[serde(default = "default_build")]
    build: String,
    #[serde(default)]
    build_assumed: bool,
    #[serde(default)]
    classification_query: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    corrections: Vec<String>,
    #[serde(default = "default_confidence")]
    confidence: String,
    #[serde(default)]
    error: Option<String>,
}

fn default_build() -> String { "hg38".into() }
fn default_confidence() -> String { "medium".into() }

async fn codex_normalize(text: &str) -> Result<Option<Variant>> {
    let prompt = format!("{}{}", NORMALIZE_PROMPT, text);
    let output_file = format!("/tmp/nano-variant-{}.json", std::process::id());

    let status = tokio::process::Command::new("codex")
        .args(["exec", "--skip-git-repo-check", "--ephemeral", "-o", &output_file])
        .arg(&prompt)
        .output()
        .await;

    let raw_output = match status {
        Ok(out) if out.status.success() => {
            let content = tokio::fs::read_to_string(&output_file).await
                .unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).to_string());
            let _ = tokio::fs::remove_file(&output_file).await;
            content
        }
        Ok(out) => {
            let _ = tokio::fs::remove_file(&output_file).await;
            tracing::warn!("[parser] Codex exited non-zero: {}", out.status);
            // Try stdout as fallback
            String::from_utf8_lossy(&out.stdout).to_string()
        }
        Err(e) => {
            tracing::warn!("[parser] Codex not available: {}", e);
            return Ok(None);
        }
    };

    // Extract JSON from output (may be wrapped in markdown fences)
    let json_str = extract_json(&raw_output);
    let resp: CodexResponse = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[parser] failed to parse Codex output: {}", e);
            return Ok(None);
        }
    };

    if resp.error.is_some() {
        tracing::warn!("[parser] Codex error: {:?}", resp.error);
        return Ok(None);
    }

    let display = if resp.display_name.is_empty() {
        resp.classification_query.clone()
    } else {
        resp.display_name.clone()
    };

    let query = if resp.classification_query.is_empty() {
        if let (Some(t), Some(c)) = (&resp.transcript, &resp.hgvs_c) {
            format!("{}:{}", t, c)
        } else if let Some(g) = &resp.genomic {
            g.clone()
        } else if let Some(rs) = &resp.rsid {
            rs.clone()
        } else {
            display.clone()
        }
    } else {
        resp.classification_query
    };

    let confidence = match resp.confidence.as_str() {
        "high" => Confidence::High,
        "low" => Confidence::Low,
        _ => Confidence::Medium,
    };

    if !resp.corrections.is_empty() {
        tracing::info!("[parser] corrections: {:?}", resp.corrections);
    }

    Ok(Some(Variant {
        format: VariantFormat::LlmNormalized,
        display_name: display,
        query,
        raw_input: text.to_string(),
        gene: resp.gene,
        transcript: resp.transcript,
        hgvs_c: resp.hgvs_c,
        hgvs_p: resp.hgvs_p,
        genomic: resp.genomic,
        rsid: resp.rsid,
        build: resp.build,
        build_assumed: resp.build_assumed,
        corrections: resp.corrections,
        confidence,
    }))
}

fn extract_json(raw: &str) -> &str {
    // Try to find JSON object in output (skip markdown fences etc.)
    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            return &raw[start..=end];
        }
    }
    raw
}
