//! Variant tracker — compares new variants against known state,
//! detects reclassifications and new submissions.

use super::{ClinVarVariant, ReclassificationEvent, Classification};
use super::state::ClinVarState;

/// Process new variants: add to state, detect reclassifications.
/// Returns (count_added, reclassification_events).
pub fn process_new_variants(
    state: &mut ClinVarState,
    new_variants: &[ClinVarVariant],
) -> (usize, Vec<ReclassificationEvent>) {
    let mut added = 0usize;
    let mut reclassified = Vec::new();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    for new_var in new_variants {
        // Check if we already know this variant
        let existing = state.variants.iter()
            .find(|v| v.variation_id == new_var.variation_id);

        match existing {
            Some(old) => {
                // Known variant — check for reclassification
                if old.classification != new_var.classification {
                    let event = ReclassificationEvent {
                        variation_id: new_var.variation_id.clone(),
                        gene: new_var.gene.clone(),
                        hgvs: new_var.hgvs.clone(),
                        old: old.classification.clone(),
                        new: new_var.classification.clone(),
                        detected_at: today.clone(),
                        submitter: new_var.submitter.clone(),
                    };

                    #[cfg(not(target_arch = "wasm32"))]
                    tracing::info!(
                        "[tracker] Reclassification: {} {} → {} ({})",
                        new_var.gene, old.classification.short(), new_var.classification.short(), new_var.hgvs
                    );

                    reclassified.push(event.clone());
                    state.reclassifications.push(event);

                    // Update the variant's classification
                    if let Some(v) = state.variants.iter_mut()
                        .find(|v| v.variation_id == new_var.variation_id)
                    {
                        v.classification = new_var.classification.clone();
                        v.last_evaluated = new_var.last_evaluated.clone();
                        v.submitter = new_var.submitter.clone();
                    }
                }
            }
            None => {
                // New variant — add to state
                state.variants.push(new_var.clone());
                added += 1;
            }
        }
    }

    (added, reclassified)
}
