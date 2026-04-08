// nano-zyrkel-vusTracker — WASM-powered ClinVar analysis in the browser.
// All computation runs locally. No data leaves the browser.

let tracker = null;
let indexCache = null;
const DATA_BASE = '.';

async function init() {
  try {
    const wasm = await import('./pkg/vus_tracker_lib.js');
    await wasm.default();
    tracker = new wasm.VusTracker();

    document.getElementById('total-variants').textContent = 'Loading...';

    // Phase 1: Load index (tiny, instant) for hero numbers
    try {
      const idxResp = await fetch(`${DATA_BASE}/data/index.json`);
      if (idxResp.ok) {
        indexCache = await idxResp.json();
        document.getElementById('total-variants').textContent = formatNumber(indexCache.total_variants || 0);
        document.getElementById('delta').textContent = `${formatNumber(indexCache.total_reclassifications || 0)} classification changes`;
      }
    } catch(e) {}

    // Phase 2: Load today's data first (tiny, instant render)
    try {
      const todayResp = await fetch(`${DATA_BASE}/data/today.jsonl`);
      if (todayResp?.ok) {
        tracker.load_variants(await todayResp.text());
        renderAll(); // Instant first paint with today's data
      }
    } catch(e) {}

    // Phase 3: Load rest in parallel (background, user already sees data)
    const [varResp, reclResp, storyResp] = await Promise.all([
      fetch(`${DATA_BASE}/data/variants.jsonl`).catch(() => null),
      fetch(`${DATA_BASE}/data/reclassifications.jsonl`).catch(() => null),
      fetch(`${DATA_BASE}/data/story.txt`).catch(() => null),
    ]);

    if (varResp?.ok) {
      tracker.load_variants(await varResp.text()); // Deduplicates automatically
    }
    if (reclResp?.ok) {
      tracker.load_reclassifications(await reclResp.text());
    }
    if (storyResp?.ok) {
      const txt = (await storyResp.text()).trim();
      if (txt) {
        document.getElementById('story').style.display = 'block';
        document.getElementById('story-text').textContent = txt;
      }
    }

    // Panels
    const panels = JSON.parse(tracker.predefined_panels());
    const sel = document.getElementById('panel-select');
    panels.forEach(p => {
      const o = document.createElement('option');
      o.value = p.genes.join(',');
      o.textContent = p.name;
      sel.appendChild(o);
    });

    // Initial render
    renderAll();

    // Events
    document.getElementById('search').addEventListener('input', onSearch);
    document.getElementById('panel-select').addEventListener('change', onPanelChange);
    document.getElementById('report-date').addEventListener('change', onReportDate);
    setupVCFDrop();

    // URL parameter: ?gene=XXX → focus that gene
    const urlGene = new URLSearchParams(window.location.search).get('gene');
    if (urlGene) {
      const g = urlGene.toUpperCase();
      renderGeneFocus(g);
      document.getElementById('search').value = g;
    }

    console.log(`vusTracker: ${tracker.variant_count()} variants, ${tracker.reclass_count()} classification changes`);
  } catch(e) {
    console.error('Init failed:', e);
    document.getElementById('total-variants').textContent = 'Error';
    document.getElementById('delta').textContent = e.message;
  }
}

// ── Render all tabs ──────────────────────────────────────────

function renderAll() {
  if (!tracker) return;

  // Hero — always use index.json for real totals (not loaded subset)
  if (indexCache) {
    document.getElementById('total-variants').textContent = formatNumber(indexCache.total_variants || 0);
    document.getElementById('delta').textContent = `${formatNumber(indexCache.total_reclassifications || 0)} classification changes`;
    document.getElementById('trend').textContent =
      `${indexCache.date_range?.from || ''} — ${indexCache.date_range?.to || ''}`;
  }

  // Tab 0: Latest
  renderLatest();

  // Tab 1: Classification Changes
  renderChanges();

  // Tab 2: Genes (from index.json, not loaded subset)
  renderGenes();

  // Tab 3: Stats (from index.json)
  renderStats();

  // Gene Focus (default: LDLR)
  renderGeneFocus(focusGene);
}

function renderLatest() {
  const el = document.getElementById('reclass-list');

  // Show mix of recent variants across classifications
  // Totals come from index.json (real numbers), not from loaded subset
  const categories = [
    { key: 'path.', label: 'Pathogenic', indexKey: 'path.', limit: 5 },
    { key: 'VUS', label: 'VUS', indexKey: 'VUS', limit: 5 },
    { key: 'l.path.', label: 'Likely Pathogenic', indexKey: 'l.path.', limit: 3 },
    { key: 'l.ben.', label: 'Likely Benign', indexKey: 'l.ben.', limit: 3 },
    { key: 'confl.', label: 'Conflicting', indexKey: 'confl.', limit: 4 },
  ];

  let html = '';
  for (const cat of categories) {
    const data = JSON.parse(tracker.filter_classification(cat.key));
    const items = (data.sample || data || []).slice(0, cat.limit);
    // Use real total from index.json, not from loaded subset
    const realTotal = indexCache?.classifications?.[cat.indexKey] || data.total || items.length;
    if (items.length) {
      html += `<div class="section-title" style="margin-top:8px">${cat.label} <span style="font-weight:400">(${formatNumber(realTotal)} in ClinVar)</span></div>`;
      html += items.map((v, i) => renderRow(v, i)).join('');
    }
  }
  el.innerHTML = html || '<div style="color:#94a3b8">Loading variants...</div>';
}

function renderChanges() {
  const el = document.getElementById('vus-list');
  const rCount = indexCache?.total_reclassifications || tracker.reclass_count();
  el.innerHTML = `<div style="color:#64748b;font-size:11px;margin-bottom:8px;line-height:1.4;">
    ${formatNumber(rCount)} classification changes detected across all ClinVar data.<br>
    A "change" means the same submitter filed a different classification for a variant over time.
    <em>These are computational observations, not clinical reclassifications.</em>
  </div>`;
  el.innerHTML += `
    <div class="section-title">Summary</div>
    <div class="row"><span>Total changes</span><span class="val">${formatNumber(rCount)}</span></div>
    <div class="row"><span>Total variants tracked</span><span class="val">${formatNumber(indexCache?.total_variants || 0)}</span></div>
  `;
}

function renderGenes() {
  const el = document.getElementById('gene-list');
  // Use top_genes from index.json (real counts over 4.2M variants)
  const topGenes = indexCache?.top_genes || [];
  if (!topGenes.length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:11px">Loading gene data...</div>';
    return;
  }
  const max = topGenes[0]?.[1] || 1;
  el.innerHTML = topGenes.slice(0, 15).map(([gene, count]) => `
    <div class="row">
      <span class="gene">${esc(gene)}</span>
      <span class="val">${formatNumber(count)} variants</span>
    </div>
    <div class="bar" style="width:${Math.round(count/max*100)}%"></div>
  `).join('');
}

function renderStats() {
  const el = document.getElementById('stats-list');
  if (!indexCache) {
    el.innerHTML = '<div style="color:#94a3b8">Loading stats...</div>';
    return;
  }

  const c = indexCache.classifications || {};
  const total = indexCache.total_variants || 0;
  const vusCount = c['VUS'] || 0;
  const pathCount = (c['path.'] || 0) + (c['l.path.'] || 0);
  const benCount = (c['benign'] || 0) + (c['l.ben.'] || 0);
  const conflCount = c['confl.'] || 0;
  const vusPercent = total ? ((vusCount / total) * 100).toFixed(1) : 0;

  el.innerHTML = `
    <div class="row"><span>Total variants in ClinVar</span><span class="val">${formatNumber(total)}</span></div>
    <div class="row"><span>VUS</span><span class="val">${formatNumber(vusCount)} (${vusPercent}%)</span></div>
    <div class="row"><span>Pathogenic / Likely</span><span class="val">${formatNumber(pathCount)}</span></div>
    <div class="row"><span>Benign / Likely</span><span class="val">${formatNumber(benCount)}</span></div>
    <div class="row"><span>Conflicting</span><span class="val">${formatNumber(conflCount)}</span></div>
    <div class="row"><span>Classification changes</span><span class="val">${formatNumber(indexCache.total_reclassifications || 0)}</span></div>
    <div class="row"><span>Date range</span><span class="val">${indexCache.date_range?.from || '?'} — ${indexCache.date_range?.to || '?'}</span></div>
    <div class="row"><span>Generated</span><span class="val">${(indexCache.generated_at || '').substring(0, 10)}</span></div>
  `;

  // LDLR survival curve (only if enough LDLR data loaded)
  try {
    const curve = JSON.parse(tracker.vus_survival_curve('LDLR'));
    if (curve.length > 2) {
      document.getElementById('survival-chart').innerHTML = renderSurvivalSVG(curve);
    } else {
      document.getElementById('survival-chart').innerHTML = '<div style="color:#94a3b8;font-size:11px">Load LDLR gene data for survival curve.</div>';
    }
  } catch(e) {}
}

let focusGene = 'LDLR';

function renderGeneFocus(gene) {
  focusGene = gene || 'LDLR';
  const nameEl = document.getElementById('focus-gene-name');
  const el = document.getElementById('focus-stats');
  if (!el || !indexCache?.gene_breakdowns) return;

  const g = indexCache.gene_breakdowns[focusGene];
  if (!g) {
    if (nameEl) nameEl.textContent = focusGene;
    el.innerHTML = `<span style="color:#94a3b8">Not in top genes</span>`;
    return;
  }

  if (nameEl) nameEl.textContent = focusGene;

  el.innerHTML = `
    <span class="focus-item"><span class="badge-sm badge-path">Path</span> ${formatNumber(g.pathogenic + g.likely_pathogenic)}</span>
    <span class="focus-item"><span class="badge-sm badge-vus">VUS</span> ${formatNumber(g.vus)}</span>
    <span class="focus-item"><span class="badge-sm badge-benign">Ben</span> ${formatNumber(g.benign + g.likely_benign)}</span>
    <span class="focus-item"><span class="badge-sm badge-confl">Confl</span> ${formatNumber(g.conflicting)}</span>
    <span class="focus-item" style="color:#64748b">Total: ${formatNumber(g.total)}</span>
  `;
}

// ── Search + Panel ───────────────────────────────────────────

function onSearch(e) {
  const q = e.target.value.trim();
  if (q.length < 2) { renderAll(); return; }
  const results = JSON.parse(tracker.search_variant(q));
  renderResultRows(results, document.getElementById('reclass-list'));
  showTab(0);
  // Update gene focus if searching for a known gene
  const upper = q.toUpperCase();
  if (indexCache?.gene_breakdowns?.[upper]) {
    renderGeneFocus(upper);
    history.replaceState(null, '', '?gene=' + encodeURIComponent(upper));
  }
}

function onReportDate(e) {
  const date = e.target.value; // YYYY-MM-DD
  if (!date || !tracker) return;
  const gene = document.getElementById('search').value.trim().toUpperCase() || '';
  const result = JSON.parse(tracker.changes_since(gene, date));
  const el = document.getElementById('reclass-list');
  const geneLabel = gene || 'all genes';

  if (result.total === 0) {
    el.innerHTML = `<div style="color:#16a34a;font-size:11px;padding:8px 0;">
      No classification changes for ${esc(geneLabel)} since ${esc(date)}.
      Your report findings are still current.
    </div>`;
  } else {
    el.innerHTML = `<div style="color:#dc2626;font-size:11px;padding:4px 0;font-weight:600;">
      ${result.total} classification change${result.total > 1 ? 's' : ''} for ${esc(geneLabel)} since ${esc(date)}:
    </div>`;
    (result.changes || []).forEach(c => {
      const arrow = `${shortClass(c.old)} → ${shortClass(c.new)}`;
      el.innerHTML += `
        <div class="row">
          <span class="gene">${esc(c.gene)}</span>
          <span class="hgvs">${esc((c.hgvs||'').substring(0, 30))}</span>
          <span class="val">${arrow} (${esc(c.detected_at)})</span>
        </div>`;
    });
    el.innerHTML += `<div style="color:#94a3b8;font-size:9px;margin-top:6px;">
      These are computational observations. Verify with the original ClinVar record and a qualified geneticist.
    </div>`;
  }
  showTab(0);
}

function onPanelChange(e) {
  const genes = e.target.value;
  if (!genes) { renderAll(); return; }
  const results = JSON.parse(tracker.panel(genes));
  renderResultRows(results, document.getElementById('reclass-list'));
  document.getElementById('reclass-list').insertAdjacentHTML('afterbegin',
    `<div class="row" style="color:#64748b;margin-bottom:4px">${results.length} variants in panel</div>`);
  showTab(0);
}

function renderResultRows(variants, container) {
  if (!variants.length) {
    container.innerHTML = '<div class="row" style="color:#94a3b8">No results.</div>';
    return;
  }
  container.innerHTML = variants.slice(0, 30).map((v, i) => renderRow(v, i)).join('');
}

function renderRow(v, idx) {
  const sc = shortClass(v.classification);
  return `
    <div class="row clickable-row" onclick="toggleCard(this, ${idx})" style="cursor:pointer;" data-variant='${esc(JSON.stringify(v))}'>
      <span class="gene">${esc(v.gene)}</span>
      <span class="hgvs">${esc((v.hgvs||'').substring(0, 35))}</span>
      <span class="badge-sm ${badgeClass(v.classification)}">${sc}</span>
    </div>
  `;
}

window.toggleCard = function(rowEl, idx) {
  const next = rowEl.nextElementSibling;
  if (next && next.classList.contains('card-expanded')) {
    next.remove();
    return;
  }
  // Remove any other expanded card
  document.querySelectorAll('.card-expanded').forEach(c => c.remove());
  try {
    const v = JSON.parse(rowEl.dataset.variant);
    const cardHtml = `<div class="card-expanded">${renderCard(v)}</div>`;
    rowEl.insertAdjacentHTML('afterend', cardHtml);
  } catch(e) {}
};

function renderCard(v) {
  const sc = shortClass(v.classification);
  const cardClass = sc.includes('path') && !sc.includes('l.') ? 'card-path'
    : sc.includes('l.path') ? 'card-lpath'
    : sc === 'VUS' ? 'card-vus'
    : sc.includes('l.ben') ? 'card-lben'
    : sc.includes('benign') ? 'card-ben'
    : sc.includes('confl') ? 'card-confl' : '';

  // Submitter count shows agreement info
  const submitterInfo = v.submitter || 'unknown';

  return `
    <div class="card ${cardClass}">
      <div class="card-header">
        <span class="card-gene">${esc(v.gene)}</span>
        <span class="badge-sm ${badgeClass(v.classification)}">${sc}</span>
      </div>
      <div class="card-hgvs">${esc(v.hgvs || '')}</div>
      <div class="card-meta">
        <span><span class="label">Condition:</span> ${esc((v.condition||'not provided').substring(0,40))}</span>
        <span><span class="label">Submissions:</span> ${esc(submitterInfo)}</span>
        <span><span class="label">Evaluated:</span> ${esc(v.last_evaluated||'—')}</span>
        <span><span class="label">Review:</span> ${esc((v.review_status||'').substring(0,25))}</span>
        <span><a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${esc(v.variation_id)}/" target="_blank" rel="noopener" style="color:#0f766e;text-decoration:underline;font-size:9px;">ClinVar →</a></span>
      </div>
    </div>
  `;
}

// ── VCF Upload ───────────────────────────────────────────────

function setupVCFDrop() {
  const drop = document.getElementById('vcf-drop');
  const input = document.getElementById('vcf-input');

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#0f766e'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = '#e2e8f0'; });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.style.borderColor = '#e2e8f0';
    if (e.dataTransfer.files.length) processVCF(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files.length) processVCF(input.files[0]); });
}

async function processVCF(file) {
  const results = document.getElementById('vcf-results');
  results.style.display = 'block';
  results.innerHTML = '<div style="color:#94a3b8">Parsing VCF locally...</div>';

  const text = await file.text();
  const match = JSON.parse(tracker.match_vcf(text));

  results.innerHTML = `
    <div class="row"><span>Total VCF variants</span><span class="val">${match.total_vcf_variants}</span></div>
    <div class="row"><span>Matched in ClinVar</span><span class="val">${match.matched_count}</span></div>
    <div class="row"><span>Not in ClinVar</span><span class="val">${match.unmatched_count}</span></div>
    <div class="row"><span class="badge-sm badge-path">Pathogenic</span><span class="val">${match.pathogenic?.length || 0}</span></div>
    <div class="row"><span class="badge-sm badge-vus">VUS</span><span class="val">${match.vus?.length || 0}</span></div>
    <div class="row"><span class="badge-sm badge-benign">Benign</span><span class="val">${match.benign?.length || 0}</span></div>
  `;

  if (match.pathogenic?.length) {
    results.innerHTML += '<div class="section-title" style="margin-top:8px">Pathogenic</div>';
    match.pathogenic.slice(0, 20).forEach(m => {
      results.innerHTML += `<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0,25)}</span><span class="badge-sm badge-path">path.</span></div>`;
    });
  }
  if (match.vus?.length) {
    results.innerHTML += '<div class="section-title" style="margin-top:8px">VUS</div>';
    match.vus.slice(0, 20).forEach(m => {
      results.innerHTML += `<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0,25)}</span><span class="badge-sm badge-vus">VUS</span></div>`;
    });
  }
}

// ── Survival SVG ─────────────────────────────────────────────

function renderSurvivalSVG(curve) {
  if (!curve.length) return '';
  const w = 360, h = 80;
  const maxD = Math.max(...curve.map(c => c[0]), 365);
  const pts = curve.map(([d,s]) => `${(d/maxD*w).toFixed(1)},${((1-s)*h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px;">
    <polyline points="${pts}" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="${w-5}" y="${h-3}" text-anchor="end" fill="#94a3b8" font-size="8">days →</text>
    <text x="3" y="10" fill="#94a3b8" font-size="8">100% VUS</text>
    <text x="3" y="${h-3}" fill="#94a3b8" font-size="8">0%</text>
  </svg>`;
}

// ── UI Helpers ────────────────────────────────────────────────

window.showTab = function(n) {
  document.querySelectorAll('.tab-content').forEach((t,i) => t.classList.toggle('active', i===n));
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', i===n));
};

function formatNumber(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  return Number(n).toLocaleString('en-US');
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function badgeClass(c) {
  const s = shortClass(c);
  if (s.includes('path')) return 'badge-path';
  if (s === 'VUS') return 'badge-vus';
  if (s.includes('ben')) return 'badge-benign';
  if (s.includes('confl')) return 'badge-confl';
  return '';
}

function shortClass(c) {
  if (!c) return '?';
  if (typeof c === 'object') {
    if ('Pathogenic' in c || c === 'Pathogenic') return 'path.';
    if ('LikelyPathogenic' in c || c === 'LikelyPathogenic') return 'l.path.';
    if ('Vus' in c || c === 'Vus') return 'VUS';
    if ('LikelyBenign' in c || c === 'LikelyBenign') return 'l.ben.';
    if ('Benign' in c || c === 'Benign') return 'benign';
    if ('ConflictingInterpretations' in c || c === 'ConflictingInterpretations') return 'confl.';
    if ('Other' in c) return c.Other || '?';
    return JSON.stringify(c).substring(0,8);
  }
  const l = String(c).toLowerCase();
  if (l.includes('pathogenic') && l.includes('likely')) return 'l.path.';
  if (l.includes('pathogenic')) return 'path.';
  if (l.includes('uncertain') || l === 'vus') return 'VUS';
  if (l.includes('benign') && l.includes('likely')) return 'l.ben.';
  if (l.includes('benign')) return 'benign';
  if (l.includes('conflicting')) return 'confl.';
  return '?';
}

function buildExportData(sep) {
  if (!indexCache) return '';
  const gene = focusGene || 'LDLR';
  const g = indexCache.gene_breakdowns?.[gene];
  const s = sep;
  let out = `Category${s}Value\n`;
  out += `Total Variants in ClinVar${s}${indexCache.total_variants}\n`;
  out += `Classification Changes${s}${indexCache.total_reclassifications}\n`;
  out += `Date Range${s}${indexCache.date_range?.from} to ${indexCache.date_range?.to}\n\n`;
  if (g) {
    out += `Gene Focus: ${gene}\n`;
    out += `Classification${s}Count\n`;
    out += `Pathogenic${s}${g.pathogenic}\n`;
    out += `Likely Pathogenic${s}${g.likely_pathogenic}\n`;
    out += `VUS${s}${g.vus}\n`;
    out += `Likely Benign${s}${g.likely_benign}\n`;
    out += `Benign${s}${g.benign}\n`;
    out += `Conflicting${s}${g.conflicting}\n`;
    out += `Total${s}${g.total}\n\n`;
  }
  out += `Top Genes\nGene${s}Variants\n`;
  (indexCache.top_genes || []).forEach(([n, c]) => { out += `${n}${s}${c}\n`; });
  out += `\nGenerated by nano-zyrkel-vusTracker\nData: NCBI ClinVar (public domain)\n`;
  return out;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], {type: mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

window.exportCSV = function() {
  const gene = focusGene || 'LDLR';
  downloadFile(buildExportData(','), `vusTracker_${gene}_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
};

window.exportTSV = function() {
  const gene = focusGene || 'LDLR';
  downloadFile(buildExportData('\t'), `vusTracker_${gene}_${new Date().toISOString().slice(0,10)}.tsv`, 'text/tab-separated-values');
};

window.exportXLSX = function() {
  // SpreadsheetML (XML-based, opens in Excel without dependencies)
  const gene = focusGene || 'LDLR';
  const g = indexCache?.gene_breakdowns?.[gene];
  let rows = '';
  const r = (cells) => '<Row>' + cells.map(c => `<Cell><Data ss:Type="${typeof c==='number'?'Number':'String'}">${c}</Data></Cell>`).join('') + '</Row>';
  rows += r(['Category', 'Value']);
  rows += r(['Total Variants', indexCache?.total_variants || 0]);
  rows += r(['Classification Changes', indexCache?.total_reclassifications || 0]);
  rows += r(['Date Range', `${indexCache?.date_range?.from} to ${indexCache?.date_range?.to}`]);
  rows += r(['', '']);
  if (g) {
    rows += r([`Gene: ${gene}`, '']);
    rows += r(['Classification', 'Count']);
    rows += r(['Pathogenic', g.pathogenic]);
    rows += r(['Likely Pathogenic', g.likely_pathogenic]);
    rows += r(['VUS', g.vus]);
    rows += r(['Likely Benign', g.likely_benign]);
    rows += r(['Benign', g.benign]);
    rows += r(['Conflicting', g.conflicting]);
    rows += r(['Total', g.total]);
    rows += r(['', '']);
  }
  rows += r(['Top Genes', '']);
  rows += r(['Gene', 'Variants']);
  (indexCache?.top_genes || []).forEach(([n, c]) => { rows += r([n, c]); });

  const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="vusTracker"><Table>${rows}</Table></Worksheet></Workbook>`;
  downloadFile(xml, `vusTracker_${gene}_${new Date().toISOString().slice(0,10)}.xls`, 'application/vnd.ms-excel');
};

window.shareLink = function() {
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({ title: `ClinVar ${focusGene} — vusTracker`, url });
  } else {
    navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
  }
};

// Embed mode
if (new URLSearchParams(window.location.search).get('embed') === 'true') {
  document.body.classList.add('embed');
}

init();
