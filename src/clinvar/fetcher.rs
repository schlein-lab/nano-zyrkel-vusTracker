//! ClinVar API client — queries NCBI E-utilities for new variant submissions.
//! Paginates through all results, not just the first batch.

use anyhow::{Context, Result};

/// Fetch IDs of recently created ClinVar entries (last 7 days).
/// Paginates through ALL results using retstart parameter.
pub async fn fetch_new_variant_ids(max: u32, delay_ms: u64) -> Result<Vec<String>> {
    let client = reqwest::Client::new();
    let mut all_ids = Vec::new();
    let mut retstart = 0u32;
    let batch_size = 500u32.min(max);

    loop {
        let url = format!(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi\
             ?db=clinvar&term=%22last+7+days%22%5Bdp%5D&retmax={}&retstart={}&retmode=json",
            batch_size, retstart
        );

        let resp = client.get(&url)
            .header("user-agent", "nano-zyrkel-clinvar/0.1 (https://zyrkel.com)")
            .send()
            .await
            .with_context(|| format!("ClinVar esearch failed (retstart={})", retstart))?;

        let body: serde_json::Value = resp.json().await?;

        let total_count: u32 = body["esearchresult"]["count"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let ids: Vec<String> = body["esearchresult"]["idlist"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let fetched = ids.len() as u32;
        all_ids.extend(ids);

        tracing::info!("[fetcher] Page {}: {} IDs (total available: {}, collected: {})",
            retstart / batch_size + 1, fetched, total_count, all_ids.len());

        // Stop conditions
        if fetched == 0 || all_ids.len() as u32 >= max || all_ids.len() as u32 >= total_count {
            break;
        }

        retstart += batch_size;
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    // Truncate to max
    all_ids.truncate(max as usize);

    Ok(all_ids)
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
    let client = reqwest::Client::new();

    // Batch in chunks of 50 (NCBI recommendation)
    for (i, chunk) in ids.chunks(50).enumerate() {
        let id_list = chunk.join(",");
        let url = format!(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi\
             ?db=clinvar&id={}&retmode=json",
            id_list
        );

        let resp = client.get(&url)
            .header("user-agent", "nano-zyrkel-clinvar/0.1 (https://zyrkel.com)")
            .send()
            .await
            .with_context(|| format!("ClinVar esummary batch {} failed", i))?;

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

        if i < ids.chunks(50).count() - 1 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    }

    tracing::info!("[fetcher] Fetched details for {} variants", all_variants.len());

    Ok(all_variants)
}
