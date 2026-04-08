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

    console.log(`vusTracker: ${tracker.variant_count()} variants, ${tracker.reclass_count()} reclassifications`);
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
}

function renderLatest() {
  const el = document.getElementById('reclass-list');

  // Try reclassifications first
  if (tracker.reclass_count() > 0) {
    // Search for any gene to get reclassified variants — use stats
    el.innerHTML = '<div class="row" style="color:#64748b">See reclassifications in Stats tab.</div>';
  }

  // Show newest variants (any classification)
  const newest = JSON.parse(tracker.search_variant('.'));
  if (newest.length > 0) {
    el.innerHTML = newest.slice(0, 15).map(v => `
      <div class="row">
        <span class="gene">${esc(v.gene)}</span>
        <span class="hgvs">${esc((v.hgvs||'').substring(0, 28))}</span>
        <span class="badge-sm ${badgeClass(v.classification)}">${shortClass(v.classification)}</span>
      </div>
    `).join('');
  } else {
    el.innerHTML = '<div class="row" style="color:#94a3b8">No data loaded.</div>';
  }
}

function renderNewVUS() {
  const el = document.getElementById('vus-list');
  const vus = JSON.parse(tracker.filter_classification('VUS'));
  if (vus.length > 0) {
    el.innerHTML = `<div class="row" style="color:#64748b;margin-bottom:6px">${formatNumber(vus.length)} VUS total</div>` +
      vus.slice(0, 15).map(v => `
        <div class="row">
          <span class="gene">${esc(v.gene)}</span>
          <span class="hgvs">${esc((v.hgvs||'').substring(0, 28))}</span>
          <span class="badge-sm badge-vus">VUS</span>
        </div>
      `).join('');
  } else {
    el.innerHTML = '<div class="row" style="color:#94a3b8">No VUS found.</div>';
  }
}

function renderGenes(stats) {
  const el = document.getElementById('gene-list');
  if (stats.gene_discord && stats.gene_discord.length > 0) {
    const max = stats.gene_discord[0][2] || 1;
    el.innerHTML = stats.gene_discord.slice(0, 10).map(([gene, discord, count]) => `
      <div class="row">
        <span class="gene">${esc(gene)}</span>
        <span class="val">${count} variants</span>
      </div>
      <div class="bar" style="width:${Math.round(count/max*100)}%"></div>
    `).join('');
  } else {
    // Fallback: show top genes from search
    const genes = ['BRCA1', 'BRCA2', 'LDLR', 'TP53', 'TTN', 'ATM', 'NF1', 'MLH1'];
    el.innerHTML = genes.map(g => {
      const results = JSON.parse(tracker.search_gene(g));
      return `<div class="row"><span class="gene">${g}</span><span class="val">${results.length} variants</span></div>`;
    }).join('');
  }
}

function renderStats(stats) {
  const el = document.getElementById('stats-list');
  el.innerHTML = `
    <div class="row"><span>Lab concordance</span><span class="val">${(stats.concordance || 0).toFixed(1)}%</span></div>
    <div class="row"><span>VUS→path. (30d)</span><span class="val">${stats.vus_to_path_30d || 0}</span></div>
    <div class="row"><span>Total variants</span><span class="val">${formatNumber(stats.total_variants || 0)}</span></div>
    <div class="row"><span>Total reclassifications</span><span class="val">${stats.total_reclassifications || 0}</span></div>
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

// ── Search + Panel ───────────────────────────────────────────

function onSearch(e) {
  const q = e.target.value.trim();
  if (q.length < 2) { renderAll(); return; }
  const results = JSON.parse(tracker.search_variant(q));
  renderResults(results, document.getElementById('reclass-list'));
  showTab(0);
}

function onPanelChange(e) {
  const genes = e.target.value;
  if (!genes) { renderAll(); return; }
  const results = JSON.parse(tracker.panel(genes));
  renderResults(results, document.getElementById('reclass-list'));
  document.getElementById('reclass-list').insertAdjacentHTML('afterbegin',
    `<div class="row" style="color:#64748b;margin-bottom:4px">${results.length} variants in panel</div>`);
  showTab(0);
}

function renderResults(variants, container) {
  if (!variants.length) {
    container.innerHTML = '<div class="row" style="color:#94a3b8">No results.</div>';
    return;
  }
  container.innerHTML = variants.slice(0, 30).map(v => `
    <div class="row">
      <span class="gene">${esc(v.gene)}</span>
      <span class="hgvs">${esc((v.hgvs||'').substring(0, 28))}</span>
      <span class="badge-sm ${badgeClass(v.classification)}">${shortClass(v.classification)}</span>
    </div>
  `).join('');
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

init();
