//! VUS Watchlist — tracks variants for ClinVar reclassification monitoring.
//!
//! Every classified variant is auto-added. Context (phenotype, notes) is optional.
//! Periodically re-checked against ClinVar; alerts on reclassification.

use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::parser::Variant;
use super::acmg::Classification;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Watchlist {
    pub variants: Vec<WatchEntry>,
    pub last_check: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchEntry {
    /// Display name of the variant
    pub display_name: String,
    /// Best query for myvariant.info
    pub query: String,
    /// Who submitted this
    pub added_by: String,
    /// When it was added
    pub added_at: String,
    /// How it came in (email, telegram, manual)
    pub channel: String,
    /// Optional context notes from submitter
    pub context: String,
    /// Context update history
    #[serde(default)]
    pub context_history: Vec<ContextUpdate>,
    /// Initial ACMG classification
    pub initial_classification: String,
    /// Last ClinVar significance seen
    pub last_clinvar_sig: String,
    /// Last time this was checked
    pub last_checked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextUpdate {
    pub text: String,
    pub by: String,
    pub at: String,
}

/// A detected reclassification.
#[derive(Debug, Clone)]
pub struct Reclassification {
    pub display_name: String,
    pub old_sig: String,
    pub new_sig: String,
    pub context: String,
    pub added_by: String,
}

impl Watchlist {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Watchlist { variants: vec![], last_check: None })
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Add a variant. Deduplicates by query; updates context on duplicates.
    /// Returns a status message.
    pub fn add(
        &mut self,
        variant: &Variant,
        requester: &str,
        channel: &str,
        context: &str,
        classification: &Classification,
    ) -> String {
        // Check for existing entry
        if let Some(existing) = self.variants.iter_mut().find(|v| v.query == variant.query) {
            if !context.is_empty() && context != existing.context {
                existing.context_history.push(ContextUpdate {
                    text: context.to_string(),
                    by: requester.to_string(),
                    at: Utc::now().to_rfc3339(),
                });
                existing.context = context.to_string();
                return format!("Watchlist aktualisiert: {} (neuer Kontext)", variant.display_name);
            }
            return format!("Bereits auf Watchlist: {}", variant.display_name);
        }

        let entry = WatchEntry {
            display_name: variant.display_name.clone(),
            query: variant.query.clone(),
            added_by: requester.to_string(),
            added_at: Utc::now().to_rfc3339(),
            channel: channel.to_string(),
            context: context.to_string(),
            context_history: vec![],
            initial_classification: classification.to_string(),
            last_clinvar_sig: String::new(),
            last_checked: None,
        };

        let ctx_note = if context.is_empty() {
            String::new()
        } else {
            format!(" — Kontext: {}", &context[..context.len().min(80)])
        };

        self.variants.push(entry);
        format!("Watchlist: {}{}", variant.display_name, ctx_note)
    }

    /// Remove entries matching an identifier.
    pub fn remove(&mut self, identifier: &str) -> String {
        let before = self.variants.len();
        let id_lower = identifier.to_lowercase();
        self.variants.retain(|v| !v.display_name.to_lowercase().contains(&id_lower));
        if self.variants.len() < before {
            format!("VUS entfernt: {}", identifier)
        } else {
            format!("VUS nicht gefunden: {}", identifier)
        }
    }

    /// List all entries as formatted text.
    pub fn list(&self) -> String {
        if self.variants.is_empty() {
            return "VUS Watchlist ist leer.".into();
        }
        let mut lines = vec![format!("VUS Watchlist ({}):", self.variants.len())];
        for (i, v) in self.variants.iter().enumerate() {
            let sig = if v.last_clinvar_sig.is_empty() { "?" } else { &v.last_clinvar_sig };
            let checked = v.last_checked.as_deref().unwrap_or("nie");
            let mut line = format!("  {}. {}", i + 1, v.display_name);
            if !v.initial_classification.is_empty() {
                line.push_str(&format!(" [{}]", v.initial_classification));
            }
            line.push_str(&format!(" — ClinVar: {} (geprueft: {})", sig, checked));
            line.push_str(&format!("\n     Eingereicht: {} von {} via {}",
                &v.added_at[..v.added_at.len().min(10)], v.added_by, v.channel));
            if !v.context.is_empty() {
                line.push_str(&format!("\n     Kontext: {}", &v.context[..v.context.len().min(120)]));
            }
            lines.push(line);
        }
        lines.join("\n")
    }

    /// Re-check all variants against ClinVar. Returns list of reclassifications.
    pub async fn watch(&mut self, client: &reqwest::Client) -> Vec<Reclassification> {
        let mut changes = Vec::new();
        let now = Utc::now().to_rfc3339();

        for entry in &mut self.variants {
            tracing::info!("[vus-watch] checking: {}", entry.query);

            let mv_data = match super::myvariant::query(client, &entry.query).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!("[vus-watch] query failed for {}: {}", entry.query, e);
                    continue;
                }
            };

            let new_sig = super::myvariant::extract_clinvar_significance(&mv_data)
                .unwrap_or_default();
            entry.last_checked = Some(now.clone());

            if !new_sig.is_empty() && new_sig != entry.last_clinvar_sig {
                changes.push(Reclassification {
                    display_name: entry.display_name.clone(),
                    old_sig: if entry.last_clinvar_sig.is_empty() {
                        "(nicht gelistet)".into()
                    } else {
                        entry.last_clinvar_sig.clone()
                    },
                    new_sig: new_sig.clone(),
                    context: entry.context.clone(),
                    added_by: entry.added_by.clone(),
                });
                entry.last_clinvar_sig = new_sig;
            }
        }

        self.last_check = Some(now);
        changes
    }
}
