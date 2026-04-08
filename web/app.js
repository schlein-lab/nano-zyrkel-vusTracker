// nano-zyrkel-vusTracker — Chunked loading + live WASM compute.
// All computation runs locally. No data leaves the browser.

let tracker = null;
let indexCache = null;
let loadedChunks = new Set();
let focusGene = 'LDLR';
let activeRange = 'all';
let searchTimeout = null;
let acIndex = -1; // autocomplete selection index

const DATA_BASE = '.';

const currentFilters = {
  gene: '',
  classes: [0, 1, 2, 3, 4, 5, 6],
  date_from: '',
  search: '',
  sort_by: 'date',
  sort_asc: false,
  limit: 50,
  offset: 0,
};

// ── Init ────────────────────────────────────────────────────

async function init() {
  try {
    const wasm = await import('./pkg/vus_tracker_lib.js');
    await wasm.default();
    tracker = new wasm.VusTracker();

    document.getElementById('total-variants').textContent = 'Loading...';

    // Load index.json (has everything for instant rendering)
    const idxResp = await fetch(`${DATA_BASE}/data/index.json`);
    if (!idxResp.ok) throw new Error('Failed to load index.json');
    indexCache = await idxResp.json();

    // Render hero + gene focus immediately from index
    renderHero('all');
    renderGeneFocus(focusGene);
    renderGenes();
    renderStats('all');

    // Events
    document.getElementById('search').addEventListener('input', onSearchInput);
    document.getElementById('search').addEventListener('keydown', onSearchKeydown);
    document.getElementById('report-date').addEventListener('change', onReportDate);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) hideAutocomplete();
    });
    setupVCFDrop();

    // URL params
    const params = new URLSearchParams(window.location.search);
    if (params.get('embed') === 'true') document.body.classList.add('embed');
    const urlGene = params.get('gene');
    if (urlGene) {
      const g = urlGene.toUpperCase();
      document.getElementById('search').value = g;
      await selectGene(g);
    }

    console.log(`vusTracker: index loaded, ${Object.keys(indexCache.gene_breakdowns || {}).length} genes`);
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('total-variants').textContent = 'Error';
    document.getElementById('delta').textContent = e.message;
  }
}

// ── Hero ────────────────────────────────────────────────────

function renderHero(period) {
  if (!indexCache) return;

  if (period === 'all' || !indexCache.by_period?.[period]) {
    document.getElementById('total-variants').textContent = formatNumber(indexCache.total_variants || 0);
    document.getElementById('delta').textContent =
      `${formatNumber(indexCache.total_reclassifications || 0)} classification changes`;
    document.getElementById('trend').textContent =
      `${indexCache.date_range?.from || '1965'} \u2014 ${indexCache.date_range?.to || '2026'}`;
  } else {
    const p = indexCache.by_period[period];
    document.getElementById('total-variants').textContent = formatNumber(p.total || 0);
    document.getElementById('delta').textContent =
      `${formatNumber(p.reclassifications || 0)} changes in ${rangeLabel(period)}`;
    document.getElementById('trend').textContent = `${p.from || ''} \u2014 ${p.to || ''}`;
  }
}

// ── Autocomplete ────────────────────────────────────────────

function onSearchInput(e) {
  const q = e.target.value.trim().toUpperCase();
  clearTimeout(searchTimeout);
  if (q.length < 1) {
    hideAutocomplete();
    return;
  }
  searchTimeout = setTimeout(() => {
    if (!indexCache?.gene_breakdowns) return;
    const keys = Object.keys(indexCache.gene_breakdowns);
    const matches = [];
    // Exact prefix first, then contains
    for (const g of keys) {
      if (g.startsWith(q)) matches.push(g);
      if (matches.length >= 20) break;
    }
    if (matches.length < 20) {
      for (const g of keys) {
        if (!g.startsWith(q) && g.includes(q)) matches.push(g);
        if (matches.length >= 20) break;
      }
    }
    showAutocomplete(matches);
  }, 200);
}

function onSearchKeydown(e) {
  const ac = document.getElementById('autocomplete');
  const items = ac.querySelectorAll('.ac-item');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acIndex = Math.min(acIndex + 1, items.length - 1);
    highlightAcItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acIndex = Math.max(acIndex - 1, 0);
    highlightAcItem(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (acIndex >= 0 && items[acIndex]) {
      selectGene(items[acIndex].dataset.gene);
    } else if (items.length === 1) {
      selectGene(items[0].dataset.gene);
    }
  } else if (e.key === 'Escape') {
    hideAutocomplete();
  }
}

function highlightAcItem(items) {
  items.forEach((el, i) => el.classList.toggle('selected', i === acIndex));
}

function showAutocomplete(genes) {
  const ac = document.getElementById('autocomplete');
  acIndex = -1;
  if (!genes.length) {
    ac.innerHTML = '<div class="ac-item" style="color:#94a3b8;pointer-events:none">No genes found</div>';
    ac.classList.add('visible');
    return;
  }
  ac.innerHTML = genes.map(g => {
    const bd = indexCache.gene_breakdowns[g];
    return `<div class="ac-item" data-gene="${esc(g)}" onclick="selectGene('${esc(g)}')">`
      + `<span>${esc(g)}</span>`
      + `<span class="ac-count">${formatNumber(bd?.total || 0)}</span>`
      + `</div>`;
  }).join('');
  ac.classList.add('visible');
}

function hideAutocomplete() {
  document.getElementById('autocomplete').classList.remove('visible');
  acIndex = -1;
}

// ── Gene Selection + Chunk Loading ──────────────────────────

window.selectGene = async function (gene) {
  gene = gene.toUpperCase();
  hideAutocomplete();
  document.getElementById('search').value = gene;
  currentFilters.gene = gene;

  // Show from index immediately
  renderGeneFocus(gene);
  history.replaceState(null, '', '?gene=' + encodeURIComponent(gene));

  // Find chunk
  const chunkId = indexCache.gene_to_chunk?.[gene];
  if (chunkId != null && !loadedChunks.has(chunkId)) {
    showLoading(`loading ${gene} data...`);
    await loadChunk(chunkId);
    hideLoading();
  }

  // If chunk loaded, re-render with WASM live
  if (chunkId != null && loadedChunks.has(chunkId)) {
    renderGeneFocus(gene);
    renderVariantList();
  }
};

async function loadChunk(chunkId) {
  if (loadedChunks.has(chunkId)) return;
  try {
    const padded = String(chunkId).padStart(2, '0');
    const resp = await fetch(`${DATA_BASE}/data/chunks/chunk_${padded}.jsonl`);
    if (resp.ok) {
      tracker.load_variants(await resp.text());
      loadedChunks.add(chunkId);
      console.log(`Loaded chunk ${chunkId}`);
    }
  } catch (e) {
    console.warn('Chunk load failed:', chunkId, e);
  }
}

// ── Gene Focus ──────────────────────────────────────────────

function renderGeneFocus(gene) {
  focusGene = gene || 'LDLR';
  const nameEl = document.getElementById('focus-gene-name');
  const statsEl = document.getElementById('focus-stats');
  const srcEl = document.getElementById('focus-source');
  const donutEl = document.getElementById('focus-donut');
  if (!statsEl) return;
  if (nameEl) nameEl.textContent = focusGene;

  let g = null;
  let source = 'index';
  const chunkId = indexCache?.gene_to_chunk?.[focusGene];

  // Try WASM live compute
  if (tracker && chunkId != null && loadedChunks.has(chunkId)) {
    try {
      g = JSON.parse(tracker.gene_stats(focusGene));
      if (g && g.total > 0) source = 'wasm';
      else g = null;
    } catch (e) { g = null; }
  }

  // Fallback to index.json
  if (!g) {
    g = indexCache?.gene_breakdowns?.[focusGene];
    source = 'index';
  }

  if (!g) {
    statsEl.innerHTML = '<span style="color:#94a3b8;font-size:10px;">Gene not found. Try searching above.</span>';
    srcEl.textContent = '';
    donutEl.innerHTML = '';
    return;
  }

  srcEl.textContent = source === 'wasm' ? 'LIVE' : '';
  srcEl.style.color = source === 'wasm' ? '#0f766e' : '#94a3b8';

  const p = (g.pathogenic || 0) + (g.likely_pathogenic || 0);
  const b = (g.benign || 0) + (g.likely_benign || 0);

  statsEl.innerHTML = `
    <span class="focus-item"><span class="badge-sm badge-path">Path</span> ${formatNumber(p)}</span>
    <span class="focus-item"><span class="badge-sm badge-vus">VUS</span> ${formatNumber(g.vus || 0)}</span>
    <span class="focus-item"><span class="badge-sm badge-benign">Ben</span> ${formatNumber(b)}</span>
    <span class="focus-item"><span class="badge-sm badge-confl">Confl</span> ${formatNumber(g.conflicting || 0)}</span>
    <span class="focus-item" style="color:#64748b;">Total: ${formatNumber(g.total || 0)}</span>
  `;

  // Donut placeholder (segments proportional)
  const total = g.total || 1;
  donutEl.innerHTML = renderDonutSVG(p, g.vus || 0, b, g.conflicting || 0, total);

  // Full donut chart with per-class breakdown
  renderDonut('focus-donut-detail', {
    pathogenic: g.pathogenic || 0,
    likely_pathogenic: g.likely_pathogenic || 0,
    vus: g.vus || 0,
    likely_benign: g.likely_benign || 0,
    benign: g.benign || 0,
    conflicting: g.conflicting || 0,
  });
}

function renderDonutSVG(path, vus, ben, confl, total) {
  if (total <= 0) return '';
  const r = 16, cx = 20, cy = 20, sw = 6;
  const circ = 2 * Math.PI * r;
  const segments = [
    { val: path, color: '#dc2626' },
    { val: vus, color: '#ca8a04' },
    { val: ben, color: '#16a34a' },
    { val: confl, color: '#d97706' },
  ].filter(s => s.val > 0);
  let offset = 0;
  const arcs = segments.map(s => {
    const len = (s.val / total) * circ;
    const dash = `${len} ${circ - len}`;
    const o = offset;
    offset += len;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${dash}" stroke-dashoffset="${-o}" />`;
  }).join('');
  return `<svg viewBox="0 0 40 40" style="width:36px;height:36px;">${arcs}</svg>`;
}

// ── Donut Chart — Classification Distribution ──────────────

function renderDonut(containerId, data) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const total = (data.pathogenic || 0) + (data.likely_pathogenic || 0) +
    (data.vus || 0) + (data.likely_benign || 0) + (data.benign || 0) + (data.conflicting || 0);
  if (total <= 0) { el.innerHTML = ''; return; }

  const segments = [
    { val: data.pathogenic || 0, color: '#dc2626', label: 'Path' },
    { val: data.likely_pathogenic || 0, color: '#f59e0b', label: 'L.Path' },
    { val: data.vus || 0, color: '#eab308', label: 'VUS' },
    { val: data.likely_benign || 0, color: '#22c55e', label: 'L.Ben' },
    { val: data.benign || 0, color: '#16a34a', label: 'Ben' },
    { val: data.conflicting || 0, color: '#8b5cf6', label: 'Confl' },
  ].filter(s => s.val > 0);

  const cx = 30, cy = 30, r = 22, ir = 14;
  let angle = -Math.PI / 2;
  const paths = segments.map(s => {
    const sweep = (s.val / total) * 2 * Math.PI;
    const a1 = angle, a2 = angle + sweep;
    angle = a2;
    const large = sweep > Math.PI ? 1 : 0;
    const x1o = cx + r * Math.cos(a1), y1o = cy + r * Math.sin(a1);
    const x2o = cx + r * Math.cos(a2), y2o = cy + r * Math.sin(a2);
    const x2i = cx + ir * Math.cos(a2), y2i = cy + ir * Math.sin(a2);
    const x1i = cx + ir * Math.cos(a1), y1i = cy + ir * Math.sin(a1);
    const d = `M${x1o},${y1o} A${r},${r} 0 ${large} 1 ${x2o},${y2o} L${x2i},${y2i} A${ir},${ir} 0 ${large} 0 ${x1i},${y1i} Z`;
    return `<path d="${d}" fill="${s.color}"><title>${s.label}: ${s.val}</title></path>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 60 60" style="width:60px;height:60px;">
    ${paths}
    <text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle"
      fill="#334155" font-size="8" font-weight="700">${total >= 1000 ? (total / 1000).toFixed(1) + 'k' : total}</text>
  </svg>`;
}

// ── Submissions Timeline — Stacked Area Chart ──────────────

function renderTimeline(containerId, timelineData) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const months = timelineData?.months;
  if (!months || !Object.keys(months).length) { el.innerHTML = ''; return; }

  const keys = Object.keys(months).sort();
  const n = keys.length;
  const w = 400, h = 80, pad = { l: 30, r: 5, t: 5, b: 18 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  // Aggregate into 3 categories per month
  const cats = keys.map(k => {
    const m = months[k];
    const p = (m['path.'] || 0) + (m['l.path.'] || 0) + (m['Pathogenic'] || 0) + (m['Likely pathogenic'] || 0);
    const v = (m['VUS'] || 0) + (m['Uncertain significance'] || 0);
    const b = (m['benign'] || 0) + (m['l.ben.'] || 0) + (m['Benign'] || 0) + (m['Likely benign'] || 0);
    return { p, v, b, total: p + v + b };
  });
  const maxY = Math.max(1, ...cats.map(c => c.total));

  function xAt(i) { return pad.l + (i / Math.max(1, n - 1)) * pw; }
  function yAt(val) { return pad.t + ph - (val / maxY) * ph; }

  // Build stacked area paths (bottom to top: benign, vus, path)
  let ptsBen = '', ptsVus = '', ptsPath = '';
  let baseLine = keys.map((_, i) => `${xAt(i)},${yAt(0)}`);
  let cumBen = cats.map(c => c.b);
  let cumVus = cats.map(c => c.b + c.v);
  let cumAll = cats.map(c => c.total);

  const areaPath = (upper, lower) => {
    const top = upper.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' L');
    const bot = [...lower].reverse().map((v, i) => `${xAt(n - 1 - i)},${yAt(v)}`).join(' L');
    return `M${top} L${bot} Z`;
  };

  const benPath = areaPath(cumBen, cats.map(() => 0));
  const vusPath = areaPath(cumVus, cumBen);
  const pathPath = areaPath(cumAll, cumVus);

  // X-axis labels (show ~5 labels)
  const step = Math.max(1, Math.floor(n / 5));
  const labels = keys.filter((_, i) => i % step === 0 || i === n - 1)
    .map(k => `<text x="${xAt(keys.indexOf(k))}" y="${h - 2}" text-anchor="middle" fill="#94a3b8" font-size="6">${k.slice(2, 7)}</text>`)
    .join('');

  // Y-axis labels
  const yLabels = `<text x="${pad.l - 3}" y="${pad.t + 4}" text-anchor="end" fill="#94a3b8" font-size="6">${maxY}</text>`
    + `<text x="${pad.l - 3}" y="${yAt(0) + 1}" text-anchor="end" fill="#94a3b8" font-size="6">0</text>`;

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px;" preserveAspectRatio="none">
    <path d="${benPath}" fill="#16a34a" opacity="0.5"/>
    <path d="${vusPath}" fill="#eab308" opacity="0.5"/>
    <path d="${pathPath}" fill="#dc2626" opacity="0.5"/>
    ${labels}${yLabels}
  </svg>`;
}

// ── Interactive VUS Survival Curve ─────────────────────────

function renderSurvivalInteractive(containerId) {
  const el = document.getElementById(containerId);
  if (!el || !tracker) { if (el) el.innerHTML = ''; return; }

  // Gene selector
  const genes = Object.keys(indexCache?.gene_breakdowns || {}).slice(0, 50);
  const selGene = focusGene || genes[0] || 'BRCA1';
  const options = genes.map(g => `<option value="${g}" ${g === selGene ? 'selected' : ''}>${g}</option>`).join('');

  el.innerHTML = `<div style="margin-bottom:4px;">
    <select id="survival-gene-sel" onchange="updateSurvivalCurve()" style="font-size:10px;padding:2px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;">
      ${options}
    </select>
    <span style="font-size:9px;color:#94a3b8;margin-left:4px;">VUS Survival</span>
  </div>
  <div id="survival-chart"></div>`;

  window.updateSurvivalCurve = function () {
    const gene = document.getElementById('survival-gene-sel').value;
    drawSurvivalCurve('survival-chart', gene);
  };
  drawSurvivalCurve('survival-chart', selGene);
}

function drawSurvivalCurve(containerId, gene) {
  const el = document.getElementById(containerId);
  if (!el || !tracker) return;

  let curve;
  try {
    curve = JSON.parse(tracker.vus_survival_curve(gene));
  } catch (e) { el.innerHTML = '<span style="color:#94a3b8;font-size:9px;">No survival data</span>'; return; }

  const points = curve.points || curve;
  if (!points || !points.length) { el.innerHTML = '<span style="color:#94a3b8;font-size:9px;">No data</span>'; return; }

  const w = 400, h = 100, pad = { l: 30, r: 10, t: 10, b: 20 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const maxX = Math.max(1, points[points.length - 1].days || points[points.length - 1].x || 1);

  function xAt(d) { return pad.l + (d / maxX) * pw; }
  function yAt(f) { return pad.t + ph - f * ph; }

  const linePts = points.map(p => {
    const d = p.days !== undefined ? p.days : p.x;
    const f = p.fraction !== undefined ? p.fraction : p.y;
    return `${xAt(d)},${yAt(f)}`;
  }).join(' L');

  // Hover circles with titles
  const circles = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 20)) === 0).map(p => {
    const d = p.days !== undefined ? p.days : p.x;
    const f = p.fraction !== undefined ? p.fraction : p.y;
    return `<circle cx="${xAt(d)}" cy="${yAt(f)}" r="3" fill="#0f766e" opacity="0"><title>Day ${d}: ${(f * 100).toFixed(1)}% still VUS</title></circle>`
      + `<circle cx="${xAt(d)}" cy="${yAt(f)}" r="8" fill="transparent"><title>Day ${d}: ${(f * 100).toFixed(1)}% still VUS</title></circle>`;
  }).join('');

  // Axes
  const xLabels = [0, Math.round(maxX / 2), maxX].map(d =>
    `<text x="${xAt(d)}" y="${h - 3}" text-anchor="middle" fill="#94a3b8" font-size="6">${d}d</text>`
  ).join('');
  const yLabels = [0, 0.5, 1].map(f =>
    `<text x="${pad.l - 3}" y="${yAt(f) + 2}" text-anchor="end" fill="#94a3b8" font-size="6">${f}</text>`
  ).join('');
  const gridLines = [0.25, 0.5, 0.75].map(f =>
    `<line x1="${pad.l}" y1="${yAt(f)}" x2="${w - pad.r}" y2="${yAt(f)}" stroke="#f1f5f9" stroke-width="0.5"/>`
  ).join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100px;">
    ${gridLines}
    <polyline points="${linePts}" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    ${circles}
    ${xLabels}${yLabels}
    <text x="${w / 2}" y="${h}" text-anchor="middle" fill="#94a3b8" font-size="5">days since VUS submission</text>
  </svg>`;
}

// ── Changes Heatmap ────────────────────────────────────────

function renderChangesHeatmap(containerId) {
  const el = document.getElementById(containerId);
  if (!el || !tracker) { if (el) el.innerHTML = ''; return; }

  let timeline;
  try {
    timeline = JSON.parse(tracker.changes_timeline());
  } catch (e) { el.innerHTML = ''; return; }

  const months = timeline?.months;
  if (!months || !Object.keys(months).length) { el.innerHTML = ''; return; }

  const keys = Object.keys(months).sort().slice(-24); // last 24 months
  const rows = ['VUS_to_path.', 'path._to_VUS', 'VUS_to_ben.', 'ben._to_VUS'];
  const rowLabels = ['VUS\u2192Path', 'Path\u2192VUS', 'VUS\u2192Ben', 'Ben\u2192VUS'];

  // Find max value for color scaling
  let maxVal = 1;
  keys.forEach(k => {
    rows.forEach(r => {
      const v = months[k]?.[r] || 0;
      if (v > maxVal) maxVal = v;
    });
  });

  const cellW = 14, cellH = 14, labelW = 50, headerH = 12;
  const w = labelW + keys.length * cellW + 4;
  const h = headerH + rows.length * cellH + 4;

  const cells = [];
  rows.forEach((row, ri) => {
    cells.push(`<text x="${labelW - 3}" y="${headerH + ri * cellH + cellH / 2 + 1}" text-anchor="end" dominant-baseline="middle" fill="#64748b" font-size="6">${rowLabels[ri]}</text>`);
    keys.forEach((k, ci) => {
      const v = months[k]?.[row] || 0;
      const intensity = v / maxVal;
      const r = Math.round(255 - intensity * (255 - 220));
      const g = Math.round(255 - intensity * (255 - 38));
      const b = Math.round(255 - intensity * (255 - 38));
      const color = v === 0 ? '#f8fafc' : `rgb(${r},${g},${b})`;
      cells.push(`<rect x="${labelW + ci * cellW}" y="${headerH + ri * cellH}" width="${cellW - 1}" height="${cellH - 1}" rx="1" fill="${color}"><title>${k}: ${rowLabels[ri]} = ${v}</title></rect>`);
    });
  });

  // Month labels (show every 3rd)
  const monthLabels = keys.filter((_, i) => i % 3 === 0).map((k, i) => {
    const ci = keys.indexOf(k);
    return `<text x="${labelW + ci * cellW + cellW / 2}" y="${headerH - 2}" text-anchor="middle" fill="#94a3b8" font-size="5">${k.slice(2, 7)}</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;" preserveAspectRatio="xMinYMin meet">
    ${monthLabels}
    ${cells.join('')}
  </svg>`;
}

// ── Variant List (from WASM query) ──────────────────────────

function renderVariantList() {
  const el = document.getElementById('variant-list');
  if (!tracker || !focusGene) { el.innerHTML = ''; return; }

  const chunkId = indexCache?.gene_to_chunk?.[focusGene];
  if (chunkId == null || !loadedChunks.has(chunkId)) {
    el.innerHTML = '';
    return;
  }

  showComputing();
  const filterJson = JSON.stringify({
    gene: currentFilters.gene || focusGene,
    classes: currentFilters.classes,
    date_from: currentFilters.date_from || undefined,
    search: currentFilters.search || undefined,
    sort_by: currentFilters.sort_by,
    sort_asc: currentFilters.sort_asc,
    limit: currentFilters.limit,
    offset: currentFilters.offset,
  });

  let result;
  try {
    result = JSON.parse(tracker.query(filterJson));
  } catch (e) {
    el.innerHTML = '<div style="color:#dc2626;font-size:10px;">Query error.</div>';
    hideComputing();
    return;
  }
  hideComputing();

  if (!result.variants || !result.variants.length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:10px;padding:4px 0;">No variants match filters.</div>';
    return;
  }

  const header = `<div style="color:#0f766e;font-size:9px;margin-bottom:2px;">${formatNumber(result.filtered)} of ${formatNumber(result.total)} variants</div>`;
  const rows = result.variants.map((v, i) => renderVariantRow(v, i)).join('');
  el.innerHTML = header + rows;
}

function renderVariantRow(v, idx) {
  const sc = shortClass(v.classification);
  return `<div class="variant-row clickable-row" onclick="toggleCard(this)" data-variant='${esc(JSON.stringify(v))}'>
    <span class="gene">${esc(v.gene)}</span>
    <span class="hgvs">${esc((v.hgvs || '').substring(0, 35))}</span>
    <span class="badge-sm ${badgeClass(v.classification)}">${sc}</span>
  </div>`;
}

window.toggleCard = function (rowEl) {
  const next = rowEl.nextElementSibling;
  if (next && next.classList.contains('card-expanded')) {
    next.remove();
    return;
  }
  document.querySelectorAll('.card-expanded').forEach(c => c.remove());
  try {
    const v = JSON.parse(rowEl.dataset.variant);
    rowEl.insertAdjacentHTML('afterend', `<div class="card-expanded">${renderCard(v)}</div>`);
  } catch (e) { /* ignore */ }
};

function renderCard(v) {
  const sc = shortClass(v.classification);
  const cardClass = sc === 'path.' ? 'card-path'
    : sc === 'l.path.' ? 'card-lpath'
    : sc === 'VUS' ? 'card-vus'
    : sc === 'l.ben.' ? 'card-lben'
    : sc === 'benign' ? 'card-ben'
    : sc === 'confl.' ? 'card-confl' : '';

  return `<div class="card ${cardClass}">
    <div class="card-header">
      <span class="card-gene">${esc(v.gene)}</span>
      <span class="badge-sm ${badgeClass(v.classification)}">${sc}</span>
    </div>
    <div class="card-hgvs">${esc(v.hgvs || '')}</div>
    <div class="card-meta">
      <span><span class="label">Condition:</span> ${esc((v.condition || 'not provided').substring(0, 40))}</span>
      <span><span class="label">Submissions:</span> ${esc(v.submitter || 'unknown')}</span>
      <span><span class="label">Evaluated:</span> ${esc(v.last_evaluated || '\u2014')}</span>
      <span><span class="label">Review:</span> ${esc((v.review_status || '').substring(0, 25))}</span>
      <span><a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${esc(v.variation_id)}/" target="_blank" rel="noopener" style="color:#0f766e;text-decoration:underline;font-size:9px;">ClinVar \u2192</a></span>
    </div>
  </div>`;
}

// ── Filters + Sort ──────────────────────────────────────────

window.toggleClass = function (classId) {
  const idx = currentFilters.classes.indexOf(classId);
  if (idx >= 0) currentFilters.classes.splice(idx, 1);
  else currentFilters.classes.push(classId);

  // Update chip UI
  document.querySelectorAll('.filter-chip').forEach(el => {
    const c = parseInt(el.dataset.class);
    el.classList.toggle('active', currentFilters.classes.includes(c));
  });

  renderVariantList();
};

window.setSort = function (field) {
  if (currentFilters.sort_by === field) {
    currentFilters.sort_asc = !currentFilters.sort_asc;
  } else {
    currentFilters.sort_by = field;
    currentFilters.sort_asc = true;
  }

  document.querySelectorAll('.sort-btn').forEach(el => {
    const isActive = el.textContent.toLowerCase().startsWith(field.substring(0, 4));
    el.classList.toggle('active', isActive);
  });

  renderVariantList();
};

// ── Time Range ──────────────────────────────────────────────

window.setRange = function (range) {
  activeRange = range;
  document.querySelectorAll('.tb').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');

  renderHero(range);
  renderStats(range);

  // If WASM data loaded, also re-filter query
  if (range !== 'all' && tracker && loadedChunks.size > 0) {
    currentFilters.date_from = rangeToDate(range);
    renderVariantList();
  } else {
    currentFilters.date_from = '';
    renderVariantList();
  }
};

function rangeToDate(range) {
  const d = new Date();
  switch (range) {
    case '7d': d.setDate(d.getDate() - 7); break;
    case '1m': d.setMonth(d.getMonth() - 1); break;
    case '1y': d.setFullYear(d.getFullYear() - 1); break;
    case '5y': d.setFullYear(d.getFullYear() - 5); break;
    case 'all': return '';
  }
  return d.toISOString().slice(0, 10);
}

function rangeLabel(r) {
  return { all: 'all time', '5y': '5 years', '1y': '1 year', '1m': '1 month', '7d': '7 days' }[r] || r;
}

// ── Tab: Genes ──────────────────────────────────────────────

function renderGenes() {
  const el = document.getElementById('gene-list');
  const topGenes = indexCache?.top_genes || [];
  if (!topGenes.length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:11px">No gene data.</div>';
    return;
  }
  const max = topGenes[0]?.[1] || 1;
  el.innerHTML = topGenes.slice(0, 15).map(([gene, count]) => `
    <div class="row clickable-row" onclick="selectGene('${esc(gene)}')" style="cursor:pointer;">
      <span class="gene">${esc(gene)}</span>
      <span class="val">${formatNumber(count)} variants</span>
    </div>
    <div class="bar" style="width:${Math.round(count / max * 100)}%"></div>
  `).join('');
}

// ── Tab: Changes ────────────────────────────────────────────

function renderChanges() {
  const el = document.getElementById('changes-list');
  const rCount = indexCache?.total_reclassifications || 0;
  el.innerHTML = `<div style="color:#64748b;font-size:11px;margin-bottom:8px;line-height:1.4;">
    ${formatNumber(rCount)} classification changes detected across all ClinVar data.<br>
    <em>These are computational observations, not clinical reclassifications.</em>
  </div>`;

  // If WASM has reclassification data, show timeline
  if (tracker && tracker.reclass_count && tracker.reclass_count() > 0) {
    try {
      const timeline = JSON.parse(tracker.changes_timeline());
      const months = Object.keys(timeline.months || {}).slice(-12);
      if (months.length) {
        el.innerHTML += '<div class="section-title" style="margin-top:6px;">Recent months</div>';
        months.forEach(m => {
          const entries = timeline.months[m];
          const total = Object.values(entries).reduce((a, b) => a + b, 0);
          el.innerHTML += `<div class="row"><span>${m}</span><span class="val">${total} changes</span></div>`;
        });
      }
    } catch (e) { /* ignore */ }
  }
}

// ── Tab: Stats ──────────────────────────────────────────────

function renderStats(period) {
  const el = document.getElementById('stats-list');
  if (!indexCache) {
    el.innerHTML = '<div style="color:#94a3b8">Loading stats...</div>';
    return;
  }

  let src = indexCache;
  let label = 'all time';
  if (period && period !== 'all' && indexCache.by_period?.[period]) {
    src = indexCache.by_period[period];
    label = rangeLabel(period);
  }

  const c = src.classifications || indexCache.classifications || {};
  const total = src.total || indexCache.total_variants || 0;
  const vusCount = c['VUS'] || 0;
  const pathCount = (c['path.'] || 0) + (c['l.path.'] || 0);
  const benCount = (c['benign'] || 0) + (c['l.ben.'] || 0);
  const conflCount = c['confl.'] || 0;
  const vusPercent = total ? ((vusCount / total) * 100).toFixed(1) : 0;
  const reclassCount = src.reclassifications || indexCache.total_reclassifications || 0;

  el.innerHTML = `
    <div class="section-title">Overview (${esc(label)})</div>
    <div class="row"><span>Total variants</span><span class="val">${formatNumber(total)}</span></div>
    <div class="row"><span>VUS</span><span class="val">${formatNumber(vusCount)} (${vusPercent}%)</span></div>
    <div class="row"><span>Pathogenic / Likely</span><span class="val">${formatNumber(pathCount)}</span></div>
    <div class="row"><span>Benign / Likely</span><span class="val">${formatNumber(benCount)}</span></div>
    <div class="row"><span>Conflicting</span><span class="val">${formatNumber(conflCount)}</span></div>
    <div class="row"><span>Classification changes</span><span class="val">${formatNumber(reclassCount)}</span></div>
    <div class="row"><span>Date range</span><span class="val">${indexCache.date_range?.from || '?'} \u2014 ${indexCache.date_range?.to || '?'}</span></div>
    <div class="row"><span>Generated</span><span class="val">${(indexCache.generated_at || '').substring(0, 10)}</span></div>
    <div id="stats-timeline-wrap" style="margin-top:10px;"></div>
    <div id="stats-survival-wrap" style="margin-top:10px;"></div>
    <div id="stats-heatmap-wrap" style="margin-top:10px;"></div>
  `;

  // Render submission timeline if WASM data available
  if (tracker && focusGene) {
    try {
      const tl = JSON.parse(tracker.submissions_timeline(focusGene));
      if (tl && tl.months) {
        const wrap = document.getElementById('stats-timeline-wrap');
        if (wrap) {
          wrap.innerHTML = '<div class="section-title" style="margin-top:4px;">Submissions Timeline</div><div id="stats-timeline"></div>';
          renderTimeline('stats-timeline', tl);
        }
      }
    } catch (e) { /* no timeline data */ }
  }

  // Render interactive survival curve
  if (tracker && loadedChunks.size > 0) {
    const wrap = document.getElementById('stats-survival-wrap');
    if (wrap) {
      wrap.innerHTML = '<div class="section-title" style="margin-top:4px;">VUS Survival Curve</div><div id="stats-survival"></div>';
      renderSurvivalInteractive('stats-survival');
    }
  }

  // Render changes heatmap
  if (tracker && loadedChunks.size > 0) {
    const wrap = document.getElementById('stats-heatmap-wrap');
    if (wrap) {
      wrap.innerHTML = '<div class="section-title" style="margin-top:4px;">Changes Heatmap</div><div id="stats-heatmap"></div>';
      renderChangesHeatmap('stats-heatmap');
    }
  }
}

// ── Report Date ─────────────────────────────────────────────

function onReportDate(e) {
  const date = e.target.value;
  if (!date || !tracker) return;
  const gene = currentFilters.gene || focusGene || '';

  let result;
  try {
    result = JSON.parse(tracker.changes_since(gene, date));
  } catch (e) { return; }

  const el = document.getElementById('variant-list');
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
      el.innerHTML += `<div class="variant-row">
        <span class="gene">${esc(c.gene)}</span>
        <span class="hgvs">${esc((c.hgvs || '').substring(0, 30))}</span>
        <span class="val" style="font-size:9px;">${shortClass(c.old)} \u2192 ${shortClass(c.new)}</span>
      </div>`;
    });
    el.innerHTML += `<div style="color:#94a3b8;font-size:9px;margin-top:6px;">
      These are computational observations. Verify with the original ClinVar record.
    </div>`;
  }
}

// ── VCF Upload ──────────────────────────────────────────────

function setupVCFDrop() {
  const drop = document.getElementById('vcf-drop');
  const input = document.getElementById('vcf-input');
  if (!drop || !input) return;

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
      results.innerHTML += `<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0, 25)}</span><span class="badge-sm badge-path">path.</span></div>`;
    });
  }
  if (match.vus?.length) {
    results.innerHTML += '<div class="section-title" style="margin-top:8px">VUS</div>';
    match.vus.slice(0, 20).forEach(m => {
      results.innerHTML += `<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0, 25)}</span><span class="badge-sm badge-vus">VUS</span></div>`;
    });
  }
}

// ── Export ───────────────────────────────────────────────────

function buildExportContent(what, sep) {
  if (!indexCache) return '';
  const s = sep;
  const gene = focusGene || 'LDLR';
  let out = '';

  if (what === 'focus' || what === 'all') {
    const genes = what === 'all'
      ? Object.keys(indexCache.gene_breakdowns || {})
      : [gene];
    out += `Gene${s}Total${s}Pathogenic${s}Likely Path.${s}VUS${s}Likely Benign${s}Benign${s}Conflicting\n`;
    genes.forEach(g => {
      const d = indexCache.gene_breakdowns?.[g];
      if (d) out += `${g}${s}${d.total}${s}${d.pathogenic}${s}${d.likely_pathogenic}${s}${d.vus}${s}${d.likely_benign}${s}${d.benign}${s}${d.conflicting}\n`;
    });
  }

  if (what === 'changes' && tracker) {
    out += `Gene${s}HGVS${s}Old${s}New${s}Date${s}Submitter\n`;
    try {
      const r = JSON.parse(tracker.changes_since('', '1900-01-01'));
      (r.changes || []).forEach(c => {
        out += `${c.gene}${s}${(c.hgvs || '').replace(/,/g, ';')}${s}${c.old}${s}${c.new}${s}${c.detected_at}${s}${(c.submitter || '').replace(/,/g, ';')}\n`;
      });
    } catch (e) { /* ignore */ }
  }

  if (what === 'top') {
    out += `Gene${s}Variants\n`;
    (indexCache.top_genes || []).forEach(([n, c]) => { out += `${n}${s}${c}\n`; });
  }

  out += `\nGenerated by nano-zyrkel-vusTracker \u00B7 Data: NCBI ClinVar (public domain)\n`;
  return out;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

window.doExport = function (format) {
  const what = document.getElementById('export-what').value;
  const gene = focusGene || 'LDLR';
  const date = new Date().toISOString().slice(0, 10);
  const label = what === 'focus' ? gene : what;

  if (format === 'csv') {
    downloadFile(buildExportContent(what, ','), `vusTracker_${label}_${date}.csv`, 'text/csv');
  } else if (format === 'tsv') {
    downloadFile(buildExportContent(what, '\t'), `vusTracker_${label}_${date}.tsv`, 'text/tab-separated-values');
  } else if (format === 'xls') {
    const content = buildExportContent(what, '\t');
    const rows = content.split('\n').filter(l => l).map(line => {
      const cells = line.split('\t').map(c => {
        const t = isNaN(c) || c === '' ? 'String' : 'Number';
        return `<Cell><Data ss:Type="${t}">${c.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Data></Cell>`;
      }).join('');
      return `<Row>${cells}</Row>`;
    }).join('');
    const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${label}"><Table>${rows}</Table></Worksheet></Workbook>`;
    downloadFile(xml, `vusTracker_${label}_${date}.xls`, 'application/vnd.ms-excel');
  }
};

window.shareLink = function () {
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({ title: `ClinVar ${focusGene} \u2014 vusTracker`, url });
  } else {
    navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
  }
};

// ── Tabs ────────────────────────────────────────────────────

window.showTab = function (n) {
  document.querySelectorAll('.tab-content').forEach((t, i) => t.classList.toggle('active', i === n));
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === n));

  // Lazy-render tab content
  if (n === 1) renderChanges();
};

// ── Loading / Computing indicators ──────────────────────────

function showLoading(msg) {
  const el = document.getElementById('loading');
  document.getElementById('loading-text').textContent = msg || 'loading...';
  el.style.display = 'block';
}

function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

function showComputing() {
  const el = document.getElementById('loading');
  document.getElementById('loading-text').textContent = '[computing...]';
  el.style.display = 'block';
}

function hideComputing() {
  document.getElementById('loading').style.display = 'none';
}

// ── UI Helpers ──────────────────────────────────────────────

function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return Number(n).toLocaleString('en-US');
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeClass(c) {
  const s = shortClass(c);
  if (s === 'path.') return 'badge-path';
  if (s === 'l.path.') return 'badge-lpath';
  if (s === 'VUS') return 'badge-vus';
  if (s === 'l.ben.') return 'badge-lben';
  if (s === 'benign') return 'badge-benign';
  if (s === 'confl.') return 'badge-confl';
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
    return JSON.stringify(c).substring(0, 8);
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

// ── Embed mode ──────────────────────────────────────────────

if (new URLSearchParams(window.location.search).get('embed') === 'true') {
  document.body.classList.add('embed');
}

init();
