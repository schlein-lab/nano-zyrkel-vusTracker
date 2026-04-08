//! ClinVar response parser — converts NCBI JSON into ClinVarVariant structs.

use super::{ClinVarVariant, Classification};

/// Parse a single entry from an esummary JSON response.
pub fn parse_esummary_entry(entry: &serde_json::Value, today: &str) -> Option<ClinVarVariant> {
    let uid = entry["uid"].as_str().unwrap_or("");
    if uid.is_empty() { return None; }

    // Extract gene symbols
    let genes = entry["genes"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|g| g["symbol"].as_str())
        .unwrap_or("unknown")
        .to_string();

    // Extract variant name / HGVS
    let title = entry["title"].as_str().unwrap_or("");
    let variation_name = entry["variation_set"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|v| v["variation_name"].as_str())
        .unwrap_or(title)
        .to_string();

    // Clinical significance
    let significance = entry["clinical_significance"]
        .as_object()
        .and_then(|cs| cs.get("description"))
        .and_then(|d| d.as_str())
        .unwrap_or("not provided");

    // Review status
    let review_status = entry["clinical_significance"]
        .as_object()
        .and_then(|cs| cs.get("review_status"))
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();

    // Submitter (first supporting submission)
    let submitter = entry["supporting_submissions"]
        .as_object()
        .and_then(|ss| ss.get("scv"))
        .and_then(|scv| scv.as_array())
        .and_then(|arr| arr.first())
        .and_then(|s| s["submitter_name"].as_str())
        .unwrap_or("unknown")
        .to_string();

    // Last evaluated date
    let last_evaluated = entry["clinical_significance"]
        .as_object()
        .and_then(|cs| cs.get("last_evaluated"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string();

    // Condition / trait
    let condition = entry["trait_set"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|t| t["trait_name"].as_str())
        .unwrap_or("")
        .to_string();

    Some(ClinVarVariant {
        variation_id: uid.to_string(),
        gene: genes,
        hgvs: variation_name,
        classification: Classification::from_str(significance),
        review_status,
        submitter,
        last_evaluated,
        condition,
        first_seen: today.to_string(),
    })
}
