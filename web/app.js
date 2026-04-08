// nano-zyrkel-vusTracker — WASM-powered ClinVar analysis in the browser.
// All computation runs locally. No data leaves the browser.

let tracker = null;
const DATA_BASE = '.';

async function init() {
  try {
    const wasm = await import('./pkg/vus_tracker_lib.js');
    await wasm.default();
    tracker = new wasm.VusTracker();

    document.getElementById('total-variants').textContent = 'Loading data...';

    // Load variants
    const varResp = await fetch(`${DATA_BASE}/data/variants.jsonl`);
    if (!varResp.ok) throw new Error('variants.jsonl not found');
    const varText = await varResp.text();
    tracker.load_variants(varText);

    // Load reclassifications
    try {
      const rResp = await fetch(`${DATA_BASE}/data/reclassifications.jsonl`);
      if (rResp.ok) tracker.load_reclassifications(await rResp.text());
    } catch(e) {}

    // Load story
    try {
      const sResp = await fetch(`${DATA_BASE}/data/story.txt`);
      if (sResp.ok) {
        const txt = (await sResp.text()).trim();
        if (txt) {
          document.getElementById('story').style.display = 'block';
          document.getElementById('story-text').textContent = txt;
        }
      }
    } catch(e) {}

    // Panels
    const panels = JSON.parse(tracker.predefined_panels());
    const sel = document.getElementById('panel-select');
    panels.forEach(p => {
      const o = document.createElement('option');
      o.value = p.genes.join(',');
      o.textContent = p.name;
      sel.appendChild(o);
    });

    // Initial render — all tabs
    renderAll();

    // Events
    document.getElementById('search').addEventListener('input', onSearch);
    document.getElementById('panel-select').addEventListener('change', onPanelChange);
    setupVCFDrop();

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

  // Hero
  const total = tracker.variant_count();
  document.getElementById('total-variants').textContent = formatNumber(total);

  // Stats
  const stats = JSON.parse(tracker.compute_stats());
  document.getElementById('delta').textContent = `${stats.new_vus_today || 0} new VUS today`;
  document.getElementById('trend').textContent = stats.monthly_trend ? stats.monthly_trend[1] : '';

  // Tab 0: Latest (recent reclassifications OR newest variants)
  renderLatest();

  // Tab 1: New VUS
  renderNewVUS();

  // Tab 2: Genes
  renderGenes(stats);

  // Tab 3: Stats
  renderStats(stats);

  // LDLR Showcase
  renderLDLR();
}

function renderLatest() {
  const el = document.getElementById('reclass-list');
  const rCount = tracker.reclass_count();

  if (rCount > 0) {
    el.innerHTML = `<div style="color:#64748b;font-size:11px;margin-bottom:8px;line-height:1.4;">
      ${formatNumber(rCount)} classification changes detected — a submitter filed a different
      classification than previous submissions for the same variant.
      <em>These are computational observations, not clinical reclassifications.</em>
    </div>`;
  }
  // Show recent pathogenic submissions as clickable rows
  const pathogenic = JSON.parse(tracker.filter_classification('path.'));
  const items = (pathogenic.sample || []).slice(0, 20);
  if (items.length) {
    el.innerHTML += '<div class="section-title">Recent pathogenic submissions</div>';
    el.innerHTML += items.map((v, i) => renderRow(v, i)).join('');
  }
}

function renderNewVUS() {
  const el = document.getElementById('vus-list');
  const vus = JSON.parse(tracker.filter_classification('VUS'));
  const total = vus.total || 0;
  const items = vus.sample || [];
  if (total > 0) {
    el.innerHTML = `<div class="row" style="color:#64748b;margin-bottom:6px">${formatNumber(total)} VUS total · showing ${items.length}</div>` +
      items.slice(0, 20).map((v, i) => renderRow(v, i)).join('');
  } else {
    el.innerHTML = '<div class="row" style="color:#94a3b8">No VUS in loaded data.</div>';
  }
}

function renderGenes(stats) {
  const el = document.getElementById('gene-list');
  // Always show key genes sorted by variant count
  const genes = ['TTN','BRCA2','ATM','NF1','APC','BRCA1','LDLR','MLH1','MSH2','TP53','MYH7','CFTR','SCN5A','FBN1','PALB2'];
  const counts = genes.map(g => {
    const r = JSON.parse(tracker.gene_stats(g));
    return [g, r.total || 0];
  }).sort((a,b) => b[1] - a[1]);

  const max = counts[0]?.[1] || 1;
  el.innerHTML = counts.filter(([,c]) => c > 0).slice(0, 10).map(([gene, count]) => `
    <div class="row">
      <span class="gene">${esc(gene)}</span>
      <span class="val">${count} variants</span>
    </div>
    <div class="bar" style="width:${Math.round(count/max*100)}%"></div>
  `).join('') || '<div style="color:#94a3b8;font-size:11px">Loading gene data...</div>';
}

function renderStats(stats) {
  const el = document.getElementById('stats-list');
  el.innerHTML = `
    <div class="row"><span>Lab concordance</span><span class="val">${(stats.concordance || 0).toFixed(1)}%</span></div>
    <div class="row"><span>VUS→path. shifts (30d)</span><span class="val">${stats.vus_to_path_30d || 0}</span></div>
    <div class="row"><span>Total variants</span><span class="val">${formatNumber(stats.total_variants || 0)}</span></div>
    <div class="row"><span>Classification changes</span><span class="val">${stats.total_reclassifications || 0}</span></div>
    <div class="row"><span>Agent since</span><span class="val">${stats.agent_start_date || '—'}</span></div>
  `;

  // VUS half-life
  if (stats.vus_half_life_by_gene && stats.vus_half_life_by_gene.length) {
    el.innerHTML += '<div class="section-title" style="margin-top:10px">VUS half-life (median days)</div>';
    stats.vus_half_life_by_gene.slice(0, 8).forEach(([gene, days]) => {
      el.innerHTML += `<div class="row"><span class="gene">${esc(gene)}</span><span class="val">${Math.round(days)}d</span></div>`;
    });
  }

  // LDLR survival curve
  try {
    const curve = JSON.parse(tracker.vus_survival_curve('LDLR'));
    if (curve.length > 2) {
      document.getElementById('survival-chart').innerHTML = renderSurvivalSVG(curve);
    } else {
      document.getElementById('survival-chart').innerHTML = '<div style="color:#94a3b8;font-size:11px">Not enough LDLR data for survival curve yet.</div>';
    }
  } catch(e) {}
}

async function renderLDLR() {
  const el = document.getElementById('ldlr-stats');
  if (!el) return;

  // Try loading dedicated LDLR gene file (all LDLR variants)
  try {
    const resp = await fetch(`${DATA_BASE}/data/gene_LDLR.jsonl`);
    if (resp.ok) {
      const text = await resp.text();
      tracker.load_variants(text); // Append to existing data
      console.log('LDLR gene file loaded');
    }
  } catch(e) {}

  try {
    const ldlr = JSON.parse(tracker.gene_stats('LDLR'));
    el.innerHTML = `
      <div class="row"><span>LDLR variants (all time)</span><span class="val">${formatNumber(ldlr.total)}</span></div>
      <div class="row"><span class="badge-sm badge-path">Pathogenic / Likely</span><span class="val">${ldlr.pathogenic + ldlr.likely_pathogenic}</span></div>
      <div class="row"><span class="badge-sm badge-vus">VUS</span><span class="val">${formatNumber(ldlr.vus)}</span></div>
      <div class="row"><span class="badge-sm badge-benign">Benign / Likely</span><span class="val">${ldlr.benign + ldlr.likely_benign}</span></div>
      <div class="row"><span class="badge-sm badge-confl">Conflicting</span><span class="val">${ldlr.conflicting}</span></div>
    `;

    // Update survival curve with full LDLR data
    const curve = JSON.parse(tracker.vus_survival_curve('LDLR'));
    if (curve.length > 2) {
      document.getElementById('survival-chart').innerHTML = renderSurvivalSVG(curve);
    }
  } catch(e) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:11px">Loading LDLR data...</div>';
  }
}

// ── Search + Panel ───────────────────────────────────────────

function onSearch(e) {
  const q = e.target.value.trim();
  if (q.length < 2) { renderAll(); return; }
  const results = JSON.parse(tracker.search_variant(q));
  renderResultRows(results, document.getElementById('reclass-list'));
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

window.setRange = function(range) {
  document.querySelectorAll('.time-bar button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (!tracker) return;
  const stats = JSON.parse(tracker.set_time_range(range));
  document.getElementById('total-variants').textContent = formatNumber(stats.total_variants || tracker.variant_count());
  document.getElementById('delta').textContent = `${stats.new_vus_today || 0} new VUS today`;
  renderStats(stats);
  renderGenes(stats);
};

function formatNumber(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.floor(n/1e3).toLocaleString('en-US');
  return String(n);
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

// Embed mode
if (new URLSearchParams(window.location.search).get('embed') === 'true') {
  document.body.classList.add('embed');
}

init();
