//! HTML widget reporter — generates an embeddable, self-contained widget
//! with inline CSS, SVG sparklines, and paginated tabs.
//! Max 400px wide, no external dependencies.

use super::{AggregateStats, Classification};
use super::state::ClinVarState;

/// Generate the complete HTML widget.
pub fn generate_widget(agg: &AggregateStats, state: &ClinVarState) -> String {
    let today_new = state.daily_stats.last()
        .map(|d| d.new_submissions)
        .unwrap_or(0);

    let sparkline = generate_sparkline(&state.daily_stats);
    let reclass_rows = render_reclass_table(&state.reclassifications);
    let new_vus_rows = render_new_vus(&state.variants);
    let gene_bars = render_gene_bars(&state.daily_stats);
    let vus_table = render_vus_half_life(&agg.vus_half_life_by_gene);

    let agent_days = {
        let start = chrono::NaiveDate::parse_from_str(&agg.agent_start_date, "%Y-%m-%d")
            .unwrap_or_else(|_| chrono::Utc::now().date_naive());
        (chrono::Utc::now().date_naive() - start).num_days().max(1)
    };

    let trend_arrow = match agg.monthly_trend.1.as_str() {
        "rising" => "&#x25B2; rising",
        "falling" => "&#x25BC; falling",
        _ => "&#x25AC; stable",
    };

    format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>ClinVar Live Tracker</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:'Segoe UI',system-ui,sans-serif;background:#fafbfc;color:#1a1a2e}}
.w{{max-width:400px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}}
.hd{{background:#0f766e;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:baseline}}
.hd h1{{font-size:13px;font-weight:600;letter-spacing:.02em}}
.hd .d{{font-size:12px;opacity:.85}}
.bn{{padding:12px 18px 4px;font-size:36px;font-weight:700;color:#0f766e}}
.st{{padding:0 18px 12px;font-size:11px;color:#64748b}}
.sp{{padding:0 18px 12px}}
.sec{{padding:10px 18px;border-top:1px solid #f1f5f9}}
.sec-t{{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:6px}}
.r{{display:flex;justify-content:space-between;font-size:12px;padding:3px 0}}
.r .g{{font-weight:600;color:#334155}}
.r .v{{color:#64748b}}
.b{{font-size:10px;padding:1px 6px;border-radius:4px;display:inline-block}}
.bp{{background:#fef2f2;color:#dc2626}}
.bv{{background:#fefce8;color:#ca8a04}}
.bb{{background:#f0fdf4;color:#16a34a}}
.tabs{{display:flex;border-top:1px solid #f1f5f9}}
.tab{{flex:1;text-align:center;padding:8px;font-size:10px;color:#64748b;cursor:pointer;border:none;background:none}}
.tab.a{{color:#0f766e;font-weight:600;border-bottom:2px solid #0f766e}}
.pg{{display:none}}.pg.a{{display:block}}
.ft{{padding:8px 18px;font-size:9px;color:#cbd5e1;text-align:center;border-top:1px solid #f1f5f9}}
.bar{{height:6px;border-radius:3px;background:#0d9488;margin:2px 0}}
</style>
</head>
<body>
<div class="w">
<div class="hd"><h1>ClinVar Live</h1><span class="d">+{today_new} today</span></div>
<div class="bn">{total}</div>
<div class="st">variants tracked &middot; {trend}</div>
<div class="sp">{sparkline}</div>
<div class="tabs">
<button class="tab a" onclick="sp(0)">Latest</button>
<button class="tab" onclick="sp(1)">New VUS</button>
<button class="tab" onclick="sp(2)">Genes</button>
<button class="tab" onclick="sp(3)">Reclass.</button>
<button class="tab" onclick="sp(4)">Stats</button>
</div>
<div class="pg a" id="p0"><div class="sec"><div class="sec-t">Recent reclassifications</div>{reclass}</div></div>
<div class="pg" id="p1"><div class="sec"><div class="sec-t">Newest VUS submissions</div>{vus}</div></div>
<div class="pg" id="p2"><div class="sec"><div class="sec-t">Most active genes (7d)</div>{genes}</div></div>
<div class="pg" id="p3"><div class="sec"><div class="sec-t">VUS half-life (median days)</div>{halflife}</div></div>
<div class="pg" id="p4"><div class="sec"><div class="sec-t">Key metrics</div>
<div class="r"><span>Lab concordance</span><span class="v">{concordance:.1}%</span></div>
<div class="r"><span>VUS&#x2192;path. (30d)</span><span class="v">{vtp}</span></div>
<div class="r"><span>Reclass. trend</span><span class="v">{trend_arrow}</span></div>
<div class="r"><span>New VUS today</span><span class="v">{nvt}</span></div>
<div class="r"><span>Agent running</span><span class="v">{days}d</span></div>
</div></div>
<div class="ft">nano-zyrkel &middot; <a href="https://zyrkel.com" style="color:#cbd5e1">zyrkel.com</a> &middot; &#x25CF;&thinsp;live</div>
</div>
<script>function sp(n){{document.querySelectorAll('.pg').forEach((p,i)=>p.classList.toggle('a',i===n));document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('a',i===n))}}</script>
</body></html>"#,
        today_new = today_new,
        total = format_number(agg.total_variants),
        trend = agg.monthly_trend.1,
        sparkline = sparkline,
        reclass = reclass_rows,
        vus = new_vus_rows,
        genes = gene_bars,
        halflife = vus_table,
        concordance = agg.concordance,
        vtp = agg.vus_to_path_30d,
        trend_arrow = trend_arrow,
        nvt = agg.new_vus_today,
        days = agent_days,
    )
}

/// SVG sparkline from daily submission counts (last 90 days).
fn generate_sparkline(daily_stats: &[super::DailyStats]) -> String {
    let values: Vec<u32> = daily_stats.iter()
        .rev().take(90).rev()
        .map(|d| d.new_submissions)
        .collect();

    if values.is_empty() {
        return "<svg viewBox=\"0 0 360 40\" style=\"width:100%;height:40px;\"><text x=\"180\" y=\"25\" text-anchor=\"middle\" fill=\"#cbd5e1\" font-size=\"11\">awaiting data</text></svg>".into();
    }

    let max = *values.iter().max().unwrap_or(&1) as f64;
    let w = 360.0f64;
    let h = 40.0f64;
    let step = w / values.len().max(1) as f64;

    let points: String = values.iter().enumerate()
        .map(|(i, v)| format!("{:.1},{:.1}", i as f64 * step, h - (*v as f64 / max.max(1.0) * h * 0.85)))
        .collect::<Vec<_>>()
        .join(" ");

    let last_x = (values.len().saturating_sub(1)) as f64 * step;
    let area = format!("0,{h} {points} {last_x},{h}", h = h, points = points, last_x = last_x);

    format!(
        "<svg viewBox=\"0 0 360 40\" style=\"width:100%;height:40px;\"><polygon points=\"{area}\" fill=\"rgba(13,148,136,0.12)\"/><polyline points=\"{line}\" fill=\"none\" stroke=\"#0d9488\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/></svg>",
        area = area, line = points,
    )
}

fn render_reclass_table(events: &[super::ReclassificationEvent]) -> String {
    if events.is_empty() {
        return r#"<div class="r" style="color:#94a3b8">No reclassifications yet.</div>"#.into();
    }
    events.iter().rev().take(8).map(|e| {
        let hgvs: String = e.hgvs.chars().take(25).collect();
        format!(
            r#"<div class="r"><span class="g">{gene}</span><span style="font-size:10px;color:#94a3b8">{hgvs}</span><span><span class="b {oc}">{old}</span> &#x2192; <span class="b {nc}">{new}</span></span></div>"#,
            gene = esc(&e.gene), hgvs = esc(&hgvs),
            oc = e.old.badge_class(), old = e.old.short(),
            nc = e.new.badge_class(), new = e.new.short(),
        )
    }).collect::<Vec<_>>().join("\n")
}

fn render_new_vus(variants: &[super::ClinVarVariant]) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let yesterday = (chrono::Utc::now() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();

    let recent: Vec<_> = variants.iter()
        .filter(|v| matches!(v.classification, Classification::Vus))
        .filter(|v| v.first_seen == today || v.first_seen == yesterday)
        .take(8)
        .collect();

    if recent.is_empty() {
        return r#"<div class="r" style="color:#94a3b8">No new VUS today.</div>"#.into();
    }

    recent.iter().map(|v| {
        let hgvs: String = v.hgvs.chars().take(25).collect();
        format!(
            r#"<div class="r"><span class="g">{gene}</span><span style="font-size:10px;color:#94a3b8">{hgvs}</span><span class="b bv">VUS</span></div>"#,
            gene = esc(&v.gene), hgvs = esc(&hgvs),
        )
    }).collect::<Vec<_>>().join("\n")
}

fn render_gene_bars(daily_stats: &[super::DailyStats]) -> String {
    // Aggregate gene counts from last 7 days
    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for d in daily_stats.iter().rev().take(7) {
        for (gene, count) in &d.top_genes {
            *counts.entry(gene.clone()).or_default() += count;
        }
    }
    let mut sorted: Vec<(String, u32)> = counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted.truncate(5);

    if sorted.is_empty() {
        return r#"<div class="r" style="color:#94a3b8">Awaiting data…</div>"#.into();
    }

    let max = sorted.first().map(|(_, c)| *c).unwrap_or(1) as f64;
    sorted.iter().map(|(gene, count)| {
        let w = (*count as f64 / max * 100.0) as u32;
        format!(
            r#"<div class="r"><span class="g">{gene}</span><span class="v">{count}</span></div><div class="bar" style="width:{w}%"></div>"#,
            gene = esc(gene), count = count, w = w,
        )
    }).collect::<Vec<_>>().join("\n")
}

fn render_vus_half_life(data: &[(String, f64)]) -> String {
    if data.is_empty() {
        return r#"<div class="r" style="color:#94a3b8">Not enough data yet.</div>"#.into();
    }
    data.iter().take(8).map(|(gene, days)| {
        format!(
            r#"<div class="r"><span class="g">{gene}</span><span class="v">{days:.0}d</span></div>"#,
            gene = esc(gene), days = days,
        )
    }).collect::<Vec<_>>().join("\n")
}

fn format_number(n: u64) -> String {
    if n >= 1_000_000 { format!("{:.1}M", n as f64 / 1_000_000.0) }
    else if n >= 1_000 { format!("{},{:03}", n / 1000, n % 1000) }
    else { n.to_string() }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
