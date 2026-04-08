// nano-zyrkel-vusTracker — WASM-powered ClinVar analysis in the browser.
// All computation runs locally. No data leaves the browser.

let tracker = null;
const DATA_BASE = '.'; // Relative to index.html

async function init() {
  try {
    // Load WASM module
    const wasm = await import('./pkg/vus_tracker_lib.js');
    await wasm.default();
    tracker = new wasm.VusTracker();

    // Load variant data
    document.getElementById('total-variants').textContent = 'Loading...';
    const variantsResp = await fetch(`${DATA_BASE}/data/variants.jsonl`);
    const variantsText = await variantsResp.text();
    tracker.load_variants(variantsText);

    // Load reclassifications
    try {
      const reclassResp = await fetch(`${DATA_BASE}/data/reclassifications.jsonl`);
      const reclassText = await reclassResp.text();
      tracker.load_reclassifications(reclassText);
    } catch(e) { console.log('No reclassifications data yet'); }

    // Load story of the day
    try {
      const storyResp = await fetch(`${DATA_BASE}/data/story.txt`);
      if (storyResp.ok) {
        const storyText = await storyResp.text();
        if (storyText.trim()) {
          document.getElementById('story').style.display = 'block';
          document.getElementById('story-text').textContent = storyText.trim();
        }
      }
    } catch(e) {}

    // Load predefined panels
    const panels = JSON.parse(tracker.predefined_panels());
    const select = document.getElementById('panel-select');
    panels.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.genes.join(',');
      opt.textContent = p.name;
      select.appendChild(opt);
    });

    // Initial render
    updateUI('7d');

    // Event listeners
    document.getElementById('search').addEventListener('input', onSearch);
    document.getElementById('panel-select').addEventListener('change', onPanelChange);
    setupVCFDrop();

    console.log(`vusTracker loaded: ${tracker.variant_count()} variants, ${tracker.reclass_count()} reclassifications`);
  } catch(e) {
    console.error('WASM init failed:', e);
    document.getElementById('total-variants').textContent = 'Failed to load';
    document.getElementById('delta').textContent = e.message;
  }
}

function updateUI(range) {
  if (!tracker) return;
  const statsJson = range ? tracker.set_time_range(range) : tracker.compute_stats();
  const stats = JSON.parse(statsJson);

  document.getElementById('total-variants').textContent = formatNumber(stats.total_variants || tracker.variant_count());
  document.getElementById('delta').textContent = `${stats.new_vus_today || 0} new VUS today`;
  document.getElementById('trend').textContent = stats.monthly_trend ? stats.monthly_trend[1] : 'stable';

  // Stats tab
  const statsList = document.getElementById('stats-list');
  statsList.innerHTML = `
    <div class="row"><span>Lab concordance</span><span class="val">${(stats.concordance || 0).toFixed(1)}%</span></div>
    <div class="row"><span>VUS→path. (30d)</span><span class="val">${stats.vus_to_path_30d || 0}</span></div>
    <div class="row"><span>Total variants</span><span class="val">${formatNumber(stats.total_variants || 0)}</span></div>
    <div class="row"><span>Total reclassifications</span><span class="val">${stats.total_reclassifications || 0}</span></div>
    <div class="row"><span>Agent since</span><span class="val">${stats.agent_start_date || '—'}</span></div>
  `;

  // VUS half-life
  if (stats.vus_half_life_by_gene && stats.vus_half_life_by_gene.length > 0) {
    statsList.innerHTML += '<div class="section-title" style="margin-top:8px">VUS half-life (days)</div>';
    stats.vus_half_life_by_gene.slice(0, 8).forEach(([gene, days]) => {
      statsList.innerHTML += `<div class="row"><span class="gene">${esc(gene)}</span><span class="val">${Math.round(days)}d</span></div>`;
    });
  }

  // Survival curve for LDLR
  try {
    const curveJson = tracker.vus_survival_curve('LDLR');
    const curve = JSON.parse(curveJson);
    if (curve.length > 2) {
      document.getElementById('survival-chart').innerHTML = renderSurvivalSVG(curve);
    }
  } catch(e) {}
}

function onSearch(e) {
  const q = e.target.value.trim();
  if (!q || q.length < 2) return;
  const results = JSON.parse(tracker.search_variant(q));
  renderResults(results, document.getElementById('reclass-list'));
  showTab(0);
}

function onPanelChange(e) {
  const genes = e.target.value;
  if (!genes) return;
  const results = JSON.parse(tracker.panel(genes));
  renderResults(results, document.getElementById('reclass-list'));
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
      <span class="hgvs">${esc(v.hgvs || '').substring(0, 30)}</span>
      <span class="badge-sm ${badgeClass(v.classification)}">${shortClass(v.classification)}</span>
    </div>
  `).join('');
}

function setupVCFDrop() {
  const drop = document.getElementById('vcf-drop');
  const input = document.getElementById('vcf-input');
  const results = document.getElementById('vcf-results');

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
  results.innerHTML = '<div style="color:#94a3b8">Parsing VCF...</div>';

  const text = await file.text();
  const matchJson = tracker.match_vcf(text);
  const match = JSON.parse(matchJson);

  results.innerHTML = `
    <div class="row"><span>Total VCF variants</span><span class="val">${match.total_vcf_variants}</span></div>
    <div class="row"><span>Matched in ClinVar</span><span class="val">${match.matched_count}</span></div>
    <div class="row"><span>Not in ClinVar</span><span class="val">${match.unmatched_count}</span></div>
    <div class="row"><span class="badge-sm badge-path">Pathogenic</span><span class="val">${match.pathogenic?.length || 0}</span></div>
    <div class="row"><span class="badge-sm badge-vus">VUS</span><span class="val">${match.vus?.length || 0}</span></div>
    <div class="row"><span class="badge-sm badge-benign">Benign</span><span class="val">${match.benign?.length || 0}</span></div>
  `;

  if (match.pathogenic?.length) {
    results.innerHTML += '<div class="section-title" style="margin-top:8px">Pathogenic matches</div>';
    match.pathogenic.forEach(m => {
      results.innerHTML += `<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0,25)}</span><span class="badge-sm badge-path">path.</span></div>`;
    });
  }
}

function renderSurvivalSVG(curve) {
  if (!curve.length) return '';
  const w = 360, h = 80;
  const maxDays = Math.max(...curve.map(c => c[0]), 365);
  const points = curve.map(([d, s]) => `${(d/maxDays*w).toFixed(1)},${((1-s)*h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px;">
    <polyline points="${points}" fill="none" stroke="#0d9488" stroke-width="1.5"/>
    <text x="${w-5}" y="${h-5}" text-anchor="end" fill="#94a3b8" font-size="8">days</text>
    <text x="5" y="10" fill="#94a3b8" font-size="8">100%</text>
  </svg>`;
}

// UI helpers
window.showTab = function(n) {
  document.querySelectorAll('.tab-content').forEach((t,i) => t.classList.toggle('active', i===n));
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', i===n));
};

window.setRange = function(range) {
  document.querySelectorAll('.time-bar button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  updateUI(range);
};

function formatNumber(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.floor(n/1e3) + ',' + String(n%1e3).padStart(3,'0');
  return String(n);
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function badgeClass(c) {
  if (!c) return '';
  const l = (typeof c === 'string' ? c : '').toLowerCase();
  if (l.includes('pathogenic') && !l.includes('likely')) return 'badge-path';
  if (l.includes('uncertain') || l === 'vus') return 'badge-vus';
  if (l.includes('benign')) return 'badge-benign';
  if (l.includes('conflicting')) return 'badge-confl';
  return '';
}

function shortClass(c) {
  if (!c) return '?';
  const l = (typeof c === 'string' ? c : JSON.stringify(c)).toLowerCase();
  if (l.includes('pathogenic') && l.includes('likely')) return 'l.path.';
  if (l.includes('pathogenic')) return 'path.';
  if (l.includes('uncertain') || l.includes('vus')) return 'VUS';
  if (l.includes('benign') && l.includes('likely')) return 'l.ben.';
  if (l.includes('benign')) return 'benign';
  if (l.includes('conflicting')) return 'confl.';
  return '?';
}

// Boot
init();
