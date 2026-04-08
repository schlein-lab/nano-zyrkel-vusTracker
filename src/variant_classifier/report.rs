//! HTML report builder for ACMG classification and prediction results.

use super::acmg::{AcmgResult, Verdict};
use super::parser::Variant;
use serde_json::Value;

/// Build full ACMG classification HTML report.
pub fn classification_html(variant: &Variant, acmg: &AcmgResult) -> String {
    let cls = &acmg.classification;
    let cls_color = cls.color();

    let mut criteria_html = String::new();
    for c in &acmg.criteria_met {
        let is_benign = c.code.starts_with('B');
        let color = if is_benign { "#388e3c" } else { "#d32f2f" };
        criteria_html.push_str(&format!(
            "<div style='padding:4px 0;'>\
             <span style='background:{color};color:#fff;padding:2px 8px;border-radius:3px;\
             font-weight:600;font-size:13px;'>{code}</span> \
             <span style='color:#555;font-size:13px;'>{desc}</span></div>",
            color = color, code = c.code, desc = c.description,
        ));
    }
    if criteria_html.is_empty() {
        criteria_html = "<p style='color:#888;'>Keine automatisch evaluierbaren Kriterien erfuellt</p>".into();
    }

    let mut predictors_html = String::new();
    for p in &acmg.evidence.predictors {
        let v_color = if p.verdict == Verdict::Pathogenic { "#d32f2f" } else { "#388e3c" };
        predictors_html.push_str(&format!(
            "<tr><td style='padding:4px 8px;font-weight:600;'>{name}</td>\
             <td style='padding:4px 8px;'>{score:.4}</td>\
             <td style='padding:4px 8px;color:{color};'>{verdict}</td></tr>",
            name = p.name, score = p.score, color = v_color,
            verdict = if p.verdict == Verdict::Pathogenic { "pathogenic" } else { "benign" },
        ));
    }
    if predictors_html.is_empty() {
        predictors_html = "<tr><td colspan='3' style='padding:6px 8px;color:#888;'>Keine Predictor-Daten verfuegbar</td></tr>".into();
    }

    let af_str = acmg.evidence.gnomad_af
        .map(|v| format!("{:.6}", v))
        .unwrap_or_else(|| "nicht gefunden (absent)".into());
    let cv_str = acmg.evidence.clinvar_significance.as_deref().unwrap_or("nicht gelistet");
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");

    format!(
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>\
         <body style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;\
         max-width:700px;margin:0 auto;padding:20px;color:#222;'>\
         <h2 style='margin:0 0 4px;'>ACMG Klassifikation</h2>\
         <p style='color:#888;margin:0 0 16px;font-size:13px;'>{now}</p>\
         <div style='background:#f5f5f5;padding:12px 16px;border-radius:8px;margin-bottom:16px;'>\
           <div style='font-size:15px;font-weight:600;margin-bottom:4px;'>Variante: <code>{display}</code></div>\
           <div style='font-size:24px;font-weight:700;color:{cls_color};margin:8px 0;'>{cls}</div>\
         </div>\
         <h3 style='margin:16px 0 8px;'>Erfuellte ACMG-Kriterien</h3>{criteria}\
         <h3 style='margin:16px 0 8px;'>Populationsfrequenz</h3>\
         <div style='padding:4px 0;'>gnomAD AF: <b>{af}</b></div>\
         <h3 style='margin:16px 0 8px;'>ClinVar</h3>\
         <div style='padding:4px 0;'>{cv}</div>\
         <h3 style='margin:16px 0 8px;'>In-silico Predictors</h3>\
         <table style='border-collapse:collapse;width:100%;'>\
           <tr style='background:#f0f0f0;'><th style='padding:6px 8px;text-align:left;'>Predictor</th>\
           <th style='padding:6px 8px;text-align:left;'>Score</th>\
           <th style='padding:6px 8px;text-align:left;'>Bewertung</th></tr>\
           {predictors}\
         </table>\
         <p style='color:#aaa;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;'>\
         nano-zyrkel variant-classifier — automatische ACMG-Klassifikation<br>\
         Hinweis: Diese automatische Bewertung ersetzt keine manuelle Kuration.</p>\
         </body></html>",
        now = now, display = variant.display_name, cls_color = cls_color, cls = cls,
        criteria = criteria_html, af = af_str, cv = cv_str, predictors = predictors_html,
    )
}

/// Build compact prediction-only HTML report.
pub fn prediction_html(variant: &Variant, mv_data: &Value) -> String {
    let dbnsfp = &mv_data["dbnsfp"];
    let cadd = &mv_data["cadd"];

    let scores: Vec<(&str, Option<f64>, &str, Box<dyn Fn(f64) -> bool>)> = vec![
        ("CADD (Phred)", super::myvariant::extract_score(cadd, &["phred"]), ">= 20", Box::new(|x| x >= 20.0)),
        ("REVEL", super::myvariant::extract_score(dbnsfp, &["revel", "score"]), ">= 0.5", Box::new(|x| x >= 0.5)),
        ("SpliceAI", {
            let keys = ["ds_ag", "ds_al", "ds_dg", "ds_dl"];
            keys.iter().filter_map(|k| super::myvariant::extract_score(dbnsfp, &["spliceai", k])).reduce(f64::max)
        }, ">= 0.2", Box::new(|x| x >= 0.2)),
        ("AlphaMissense", super::myvariant::extract_score(dbnsfp, &["alphamissense", "score"]), ">= 0.564", Box::new(|x| x >= 0.564)),
        ("PolyPhen2", super::myvariant::extract_score(dbnsfp, &["polyphen2", "hdiv", "score"]), ">= 0.453", Box::new(|x| x >= 0.453)),
        ("SIFT", super::myvariant::extract_score(dbnsfp, &["sift", "score"]), "< 0.05", Box::new(|x| x < 0.05)),
    ];

    let mut rows = String::new();
    for (name, score, threshold, is_path) in &scores {
        if let Some(s) = score {
            let verdict = if is_path(*s) { "pathogenic" } else { "benign" };
            let color = if is_path(*s) { "#d32f2f" } else { "#388e3c" };
            rows.push_str(&format!(
                "<tr><td style='padding:4px 8px;font-weight:600;'>{}</td>\
                 <td style='padding:4px 8px;'>{:.4}</td>\
                 <td style='padding:4px 8px;'>{}</td>\
                 <td style='padding:4px 8px;color:{};'>{}</td></tr>",
                name, s, threshold, color, verdict,
            ));
        } else {
            rows.push_str(&format!(
                "<tr><td style='padding:4px 8px;font-weight:600;'>{}</td>\
                 <td colspan='3' style='padding:4px 8px;color:#888;'>n/a</td></tr>", name,
            ));
        }
    }

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");
    format!(
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>\
         <body style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;\
         max-width:700px;margin:0 auto;padding:20px;color:#222;'>\
         <h2>In-silico Prediction: <code>{display}</code></h2>\
         <p style='color:#888;font-size:13px;'>{now}</p>\
         <table style='border-collapse:collapse;width:100%;'>\
           <tr style='background:#f0f0f0;'>\
           <th style='padding:6px 8px;text-align:left;'>Predictor</th>\
           <th style='padding:6px 8px;text-align:left;'>Score</th>\
           <th style='padding:6px 8px;text-align:left;'>Threshold</th>\
           <th style='padding:6px 8px;text-align:left;'>Bewertung</th></tr>\
           {rows}\
         </table>\
         <p style='color:#aaa;font-size:11px;margin-top:24px;border-top:1px solid #eee;\
         padding-top:12px;'>nano-zyrkel variant-classifier</p>\
         </body></html>",
        display = variant.display_name, now = now, rows = rows,
    )
}
