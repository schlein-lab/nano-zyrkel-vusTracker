//! myvariant.info API client — aggregator for ClinVar, gnomAD, CADD, dbNSFP etc.

use anyhow::Result;
use serde_json::Value;

const BASE_URL: &str = "https://myvariant.info/v1";
const USER_AGENT: &str = "nano-zyrkel-variant-classifier/1.0";

const FIELDS: &str = "\
    clinvar,clinvar.rcv,clinvar.clinical_significance,\
    gnomad_genome,gnomad_exome,\
    cadd,cadd.phred,\
    dbnsfp.revel,dbnsfp.sift,dbnsfp.polyphen2,\
    dbnsfp.spliceai,dbnsfp.alphamissense,\
    snpeff";

/// Query myvariant.info for a variant. Returns the first hit or empty object.
pub async fn query(client: &reqwest::Client, variant_id: &str) -> Result<Value> {
    let email = std::env::var("MYVARIANT_EMAIL").unwrap_or_default();
    let mut url = format!(
        "{}/query?q={}&fields={}&size=1",
        BASE_URL,
        urlencoding::encode(variant_id),
        FIELDS,
    );
    if !email.is_empty() {
        url.push_str(&format!("&email={}", urlencoding::encode(&email)));
    }

    let resp: Value = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?
        .json()
        .await?;

    let hit = resp["hits"]
        .as_array()
        .and_then(|a| a.first().cloned())
        .unwrap_or(Value::Object(serde_json::Map::new()));

    Ok(hit)
}

/// Direct ClinVar query via NCBI E-utilities as fallback.
pub async fn query_clinvar_direct(client: &reqwest::Client, variant_id: &str) -> Result<Value> {
    let search_url = format!(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?\
         db=clinvar&term={}&retmax=5&retmode=json",
        urlencoding::encode(variant_id),
    );

    let resp: Value = client.get(&search_url).send().await?.json().await?;
    let ids: Vec<&str> = resp["esearchresult"]["idlist"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    if ids.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }

    let summary_url = format!(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?\
         db=clinvar&id={}&retmode=json",
        ids.join(","),
    );

    let summary: Value = client.get(&summary_url).send().await?.json().await?;
    Ok(summary)
}

/// Helper: extract a nested f64 score from serde_json::Value.
pub fn extract_score(data: &Value, path: &[&str]) -> Option<f64> {
    let mut current = data;
    for key in path {
        current = &current[*key];
    }
    match current {
        Value::Number(n) => n.as_f64(),
        Value::Array(arr) => arr.iter().filter_map(|v| v.as_f64()).reduce(f64::max),
        _ => None,
    }
}

/// Helper: extract clinical significance string from ClinVar data.
pub fn extract_clinvar_significance(data: &Value) -> Option<String> {
    let cv = &data["clinvar"];
    let sig = &cv["clinical_significance"];
    match sig {
        Value::String(s) => Some(s.clone()),
        Value::Object(o) => o.get("description").and_then(|v| v.as_str()).map(String::from),
        Value::Array(arr) => {
            let parts: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
            if parts.is_empty() { None } else { Some(parts.join(", ")) }
        }
        _ => None,
    }
}

/// Helper: extract gnomAD allele frequency.
pub fn extract_gnomad_af(data: &Value) -> Option<f64> {
    // Try genome first, then exome
    extract_score(data, &["gnomad_genome", "af", "af"])
        .or_else(|| extract_score(data, &["gnomad_genome", "af"]))
        .or_else(|| extract_score(data, &["gnomad_exome", "af", "af"]))
        .or_else(|| extract_score(data, &["gnomad_exome", "af"]))
}

/// Convenience: urlencoding dependency is already in reqwest, but we use a minimal one.
mod urlencoding {
    pub fn encode(s: &str) -> String {
        s.chars().map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            _ => format!("%{:02X}", c as u32),
        }).collect()
    }
}
