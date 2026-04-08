//! ClinVar API client — queries NCBI E-utilities for new variant submissions.

use anyhow::{Context, Result};

/// Fetch IDs of recently created ClinVar entries (last 24h).
pub async fn fetch_new_variant_ids(max: u32, delay_ms: u64) -> Result<Vec<String>> {
    let url = format!(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi\
         ?db=clinvar&term=%22last+7+days%22%5Bdp%5D&retmax={}&retmode=json",
        max
    );

    let client = reqwest::Client::new();
    let resp = client.get(&url)
        .header("user-agent", "nano-zyrkel-clinvar/0.1 (https://zyrkel.com)")
        .send()
        .await
        .with_context(|| "ClinVar esearch failed")?;

    let body: serde_json::Value = resp.json().await?;

    let ids: Vec<String> = body["esearchresult"]["idlist"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Rate limit compliance
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

    Ok(ids)
}

/// Fetch detailed summary for a batch of variant IDs.
pub async fn fetch_variant_details(
    ids: &[String],
    delay_ms: u64,
) -> Result<Vec<super::ClinVarVariant>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let mut all_variants = Vec::new();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    // Batch in chunks of 50 (NCBI recommendation)
    for chunk in ids.chunks(50) {
        let id_list = chunk.join(",");
        let url = format!(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi\
             ?db=clinvar&id={}&retmode=json",
            id_list
        );

        let client = reqwest::Client::new();
        let resp = client.get(&url)
            .header("user-agent", "nano-zyrkel-clinvar/0.1 (https://zyrkel.com)")
            .send()
            .await
            .with_context(|| "ClinVar esummary failed")?;

        let body: serde_json::Value = resp.json().await?;

        if let Some(result) = body["result"].as_object() {
            for (uid, entry) in result {
                if uid == "uids" { continue; }
                let variant = super::parser::parse_esummary_entry(entry, &today);
                if let Some(v) = variant {
                    all_variants.push(v);
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    Ok(all_variants)
}
