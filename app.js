// nano-zyrkel-vusTracker — Two-mode UI: Overview + Gene Dashboard.
// All computation runs locally via WASM. No data leaves the browser.
let tracker = null, indexCache = null, loadedChunks = new Set();
let focusGene = '', activeRange = 'all', searchTimeout = null, acIndex = -1;
const DATA_BASE = '.';
const currentFilters = { gene:'', classes:[0,1,2,3,4,5,6], date_from:'', search:'', sort_by:'date', sort_asc:false, limit:50, offset:0 };
const $ = id => document.getElementById(id);
let lastHeroGene = '';

window.toggleSection = function(el) {
  const body = el.nextElementSibling;
  if (body) {
    el.classList.toggle('collapsed');
    body.classList.toggle('collapsed');
  }
};

function animateNumber(el, target, duration = 800) {
  const start = 0;
  const startTime = performance.now();
  function frame(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * eased);
    el.textContent = fmt(current);
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function init() {
  try {
    const wasm = await import('./pkg/vus_tracker_lib.js');
    await wasm.default(); tracker = new wasm.VusTracker();
    $('hero-number').textContent = 'Loading...';
    const r = await fetch(`${DATA_BASE}/data/index.json`);
    if (!r.ok) throw new Error('Failed to load index.json');
    indexCache = await r.json();
    renderOverview();
    $('search').addEventListener('input', onSearchInput);
    $('search').addEventListener('keydown', onSearchKeydown);
    $('report-date').addEventListener('change', onReportDate);
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) hideAutocomplete(); });
    setupVCFDrop();
    const params = new URLSearchParams(window.location.search);
    if (params.get('embed') === 'true') document.body.classList.add('embed');
    const urlGene = params.get('gene');
    await selectGene(urlGene ? urlGene.toUpperCase() : 'LDLR');
  } catch (e) {
    console.error('Init failed:', e);
    $('hero-number').textContent = 'Error'; $('hero-subtitle').textContent = e.message;
  }
}

// ── Overview Mode ──────────────────────────────────────────
function renderOverview() {
  $('overview-mode').style.display = ''; $('gene-mode').style.display = 'none'; $('clear-btn').style.display = 'none';
  renderHero(); renderTopGenes(); renderIdeogram();
}

function renderHero() {
  if (!indexCache) return;
  const heroEl = $('hero-number');
  if (activeRange === 'all' || !indexCache.by_period?.[activeRange]) {
    const target = indexCache.total_variants || 0;
    if (lastHeroGene !== '__overview__') { animateNumber(heroEl, target); lastHeroGene = '__overview__'; }
    else heroEl.textContent = fmt(target);
    $('hero-subtitle').textContent = `${fmt(indexCache.total_reclassifications || 0)} classification changes \u00B7 ${indexCache.date_range?.from || '1965'} \u2014 ${indexCache.date_range?.to || '2026'}`;
  } else {
    const p = indexCache.by_period[activeRange];
    heroEl.textContent = fmt(p.total || 0);
    $('hero-subtitle').textContent = `${fmt(p.changes || p.reclassifications || 0)} changes in ${rangeLabel(activeRange)}`;
  }
}

function renderTopGenes() {
  const el = $('top-genes-section'), top = indexCache?.top_genes || [];
  if (!top.length) { el.innerHTML = '<div class="section-title">Top Genes</div><div class="section-body"><div style="color:#94a3b8;font-size:10px;">No gene data.</div></div>'; return; }
  const max = top[0]?.[1] || 1;
  el.innerHTML = '<div class="section-title" onclick="toggleSection(this)">Top Genes</div><div class="section-body">' + top.slice(0, 15).map(([g, c]) =>
    `<div class="row clickable-row" onclick="selectGene('${esc(g)}')" style="cursor:pointer;"><span class="gene">${esc(g)}</span><span class="val">${fmt(c)} variants</span></div><div class="bar" style="width:${Math.round(c/max*100)}%"></div>`
  ).join('') + '</div>';
}

// ── Gene Selection ─────────────────────────────────────────
window.selectGene = async function(gene) {
  gene = gene.toUpperCase(); hideAutocomplete();
  focusGene = gene; currentFilters.gene = gene;
  $('search').value = gene;
  history.replaceState(null, '', '?gene=' + encodeURIComponent(gene));
  $('overview-mode').style.display = 'none'; $('gene-mode').style.display = ''; $('clear-btn').style.display = '';
  renderGeneHeader(gene); renderFilterBar();
  const geneTotal = indexCache?.gene_breakdowns?.[gene]?.total || 0;
  const heroEl = $('hero-number');
  if (lastHeroGene !== gene) { animateNumber(heroEl, geneTotal); lastHeroGene = gene; }
  else heroEl.textContent = fmt(geneTotal);
  $('hero-subtitle').textContent = `${esc(gene)} variants tracked`;
  // Show placeholder sections immediately (before chunk loads)
  $('variant-list').innerHTML = '<div style="color:#94a3b8;font-size:10px;padding:8px;">Loading variant data...</div>';
  ['browser-section','drift-section','hotspot-section','timeline-section','concordance-section','survival-section'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = '<div class="section-title">Loading...</div><div style="color:#94a3b8;font-size:9px;padding:4px 0;">Downloading gene data (~60 MB)...</div>';
  });

  // Load chunk (60 MB, takes 10-30s)
  const chunkId = indexCache?.gene_to_chunk?.[gene];
  if (chunkId != null && !loadedChunks.has(chunkId)) {
    showLoading(`loading ${gene} data (${chunkId + 1}/22)...`);
    await loadChunk(chunkId);
    hideLoading();
  }

  // Render everything after chunk load
  if (chunkId != null && loadedChunks.has(chunkId)) {
    renderGeneHeader(gene);
    renderVariantList();
    renderGenomeBrowser('genome-browser', gene);
    renderDrift(gene);
    renderHotspots(gene);
    renderTimeline(gene);
    renderConcordance(gene);
    renderSurvival(gene);
  } else {
    // Chunk failed — show what we can from index.json
    $('variant-list').innerHTML = '<div style="color:#dc2626;font-size:10px;padding:8px;">Could not load variant data. Try refreshing.</div>';
  }
};

window.clearGene = function() {
  focusGene = ''; currentFilters.gene = ''; $('search').value = '';
  history.replaceState(null, '', window.location.pathname); renderOverview();
};

window.selectCondition = async function(condition) {
  hideAutocomplete(); $('search').value = condition;
  if (!tracker || !focusGene) return;
  showLoading('filtering by condition...');
  try {
    const result = JSON.parse(tracker.filter_by_condition(condition)); hideLoading();
    const el = $('variant-list');
    if (!result.variants?.length) { el.innerHTML = `<div style="color:#94a3b8;font-size:10px;padding:4px 0;">No variants for "${esc(condition.substring(0,50))}".</div>`; return; }
    el.innerHTML = `<div style="color:#8b5cf6;font-size:9px;margin-bottom:2px;">${fmt(result.variants.length)} variants</div>` + result.variants.slice(0,50).map(v => renderVariantRow(v)).join('');
  } catch(e) { hideLoading(); }
};

async function loadChunk(id) {
  if (loadedChunks.has(id)) return;
  try {
    const r = await fetch(`${DATA_BASE}/data/chunks/chunk_${String(id).padStart(2,'0')}.jsonl`);
    if (r.ok) { tracker.load_variants(await r.text()); loadedChunks.add(id); }
  } catch(e) { console.warn('Chunk load failed:', id, e); }
}

// ── Gene Header ────────────────────────────────────────────
function renderGeneHeader(gene) {
  const el = $('gene-header'); if (!el) return;
  let g = null, source = 'index';
  const cid = indexCache?.gene_to_chunk?.[gene];
  if (tracker && cid != null && loadedChunks.has(cid)) {
    try { g = JSON.parse(tracker.gene_stats(gene)); if (g?.total > 0) source = 'wasm'; else g = null; } catch(e) { g = null; }
  }
  if (!g) g = indexCache?.gene_breakdowns?.[gene];
  if (!g) { el.innerHTML = `<span style="color:#94a3b8;font-size:10px;">Gene "${esc(gene)}" not found.</span>`; return; }
  const p = (g.pathogenic||0)+(g.likely_pathogenic||0), b = (g.benign||0)+(g.likely_benign||0), total = g.total||1;
  const src = source === 'wasm' ? '<span class="gene-source">LIVE</span>' : '';
  el.innerHTML = `<div class="gene-header-top"><span class="gene-name">${esc(gene)}</span>${src}</div>`
    + `<div class="gene-stats"><span class="gene-stat"><span class="badge-sm badge-path">Path</span> ${fmt(p)}</span>`
    + `<span class="gene-stat"><span class="badge-sm badge-vus">VUS</span> ${fmt(g.vus||0)}</span>`
    + `<span class="gene-stat"><span class="badge-sm badge-benign">Ben</span> ${fmt(b)}</span>`
    + `<span class="gene-stat"><span class="badge-sm badge-confl">Confl</span> ${fmt(g.conflicting||0)}</span>`
    + `<span class="gene-stat" style="color:#64748b;">Total: ${fmt(g.total||0)}</span></div>`
    + `<div class="gene-donut">${donutSVG(p, g.vus||0, b, g.conflicting||0, total)}</div>`;
}

function donutSVG(path, vus, ben, confl, total) {
  if (total <= 0) return '';
  const r=16, cx=20, cy=20, sw=6, circ=2*Math.PI*r;
  const segs = [{val:path,color:'#dc2626'},{val:vus,color:'#ca8a04'},{val:ben,color:'#16a34a'},{val:confl,color:'#d97706'}].filter(s=>s.val>0);
  let off = 0;
  return `<svg viewBox="0 0 40 40" style="width:36px;height:36px;">${segs.map(s => {
    const len = (s.val/total)*circ, o = off; off += len;
    return `<circle class="donut-segment" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-o}"/>`;
  }).join('')}</svg>`;
}

// ── Filter Bar + Variant List ──────────────────────────────
function renderFilterBar() {
  const el = $('filter-bar'); if (!el) return;
  const chips = [[0,'Path'],[1,'LP'],[2,'VUS'],[3,'LB'],[4,'Ben'],[5,'Confl']].map(([c,l]) =>
    `<button class="filter-chip ${currentFilters.classes.includes(c)?'active':''}" data-class="${c}" onclick="toggleClass(${c})">${l}</button>`).join('');
  const sorts = ['date','classification','hgvs','gene'].map(s =>
    `<button class="sort-btn ${currentFilters.sort_by===s?'active':''}" onclick="setSort('${s}')">${s.charAt(0).toUpperCase()+s.slice(1,5)}</button>`).join('');
  el.innerHTML = `<div class="filter-chips">${chips}</div><div class="sort-controls">${sorts}</div>`;
}

window.toggleClass = function(c) {
  const i = currentFilters.classes.indexOf(c);
  if (i >= 0) currentFilters.classes.splice(i, 1); else currentFilters.classes.push(c);
  renderFilterBar(); renderVariantList();
};
window.setSort = function(f) {
  if (currentFilters.sort_by === f) currentFilters.sort_asc = !currentFilters.sort_asc;
  else { currentFilters.sort_by = f; currentFilters.sort_asc = true; }
  renderFilterBar(); renderVariantList();
};

function renderVariantList() {
  const el = $('variant-list');
  if (!tracker || !focusGene) { el.innerHTML = ''; return; }
  const cid = indexCache?.gene_to_chunk?.[focusGene];
  if (cid == null || !loadedChunks.has(cid)) { el.innerHTML = ''; return; }
  let result;
  try { result = JSON.parse(tracker.query(JSON.stringify({
    gene: currentFilters.gene||focusGene, classes: currentFilters.classes,
    date_from: currentFilters.date_from||undefined, search: currentFilters.search||undefined,
    sort_by: currentFilters.sort_by, sort_asc: currentFilters.sort_asc,
    limit: currentFilters.limit, offset: currentFilters.offset,
  }))); } catch(e) { el.innerHTML = '<div style="color:#dc2626;font-size:10px;">Query error.</div>'; return; }
  if (!result.variants?.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:10px;padding:4px 0;">No variants match filters.</div>'; return; }
  el.innerHTML = `<div style="color:#0f766e;font-size:9px;margin-bottom:2px;">${fmt(result.filtered)} of ${fmt(result.total)} variants</div>` + result.variants.map(v => renderVariantRow(v)).join('');
}

function renderVariantRow(v) {
  return `<div class="variant-row clickable-row" onclick="toggleCard(this)" data-variant='${esc(JSON.stringify(v))}'><span class="gene">${esc(v.gene)}</span><span class="hgvs">${esc((v.hgvs||'').substring(0,35))}</span><span class="badge-sm ${badgeClass(v.classification)}">${shortClass(v.classification)}</span></div>`;
}

window.toggleCard = function(row) {
  const next = row.nextElementSibling;
  if (next?.classList.contains('card-expanded')) { next.remove(); return; }
  document.querySelectorAll('.card-expanded').forEach(c => c.remove());
  try { const v = JSON.parse(row.dataset.variant);
    const sc = shortClass(v.classification);
    const cc = {'path.':'card-path','l.path.':'card-lpath','VUS':'card-vus','l.ben.':'card-lben','benign':'card-ben','confl.':'card-confl'}[sc]||'';
    row.insertAdjacentHTML('afterend', `<div class="card-expanded"><div class="card ${cc}"><div class="card-header"><span class="card-gene">${esc(v.gene)}</span><span class="badge-sm ${badgeClass(v.classification)}">${sc}</span></div><div class="card-hgvs">${esc(v.hgvs||'')}</div><div class="card-meta"><span><span class="label">Condition:</span> ${esc((v.condition||'not provided').substring(0,40))}</span><span><span class="label">Submissions:</span> ${esc(v.submitter||'unknown')}</span><span><span class="label">Evaluated:</span> ${esc(v.last_evaluated||'\u2014')}</span><span><span class="label">Review:</span> ${esc((v.review_status||'').substring(0,25))}</span><span><a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${esc(v.variation_id)}/" target="_blank" rel="noopener" style="color:#0f766e;text-decoration:underline;font-size:9px;">ClinVar \u2192</a></span></div></div></div>`);
  } catch(e) {}
};

// ── Time Range ─────────────────────────────────────────────
window.setRange = function(range) {
  activeRange = range;
  document.querySelectorAll('.tb').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (focusGene) {
    currentFilters.date_from = range !== 'all' ? rangeToDate(range) : '';
    const cid = indexCache?.gene_to_chunk?.[focusGene];
    if (range !== 'all' && tracker && cid != null && loadedChunks.has(cid)) {
      try {
        const result = JSON.parse(tracker.query(JSON.stringify({ gene: focusGene, date_from: rangeToDate(range), limit: 0 })));
        const totalAll = indexCache?.gene_breakdowns?.[focusGene]?.total || 0;
        $('hero-number').textContent = fmt(result.filtered || 0);
        $('hero-subtitle').textContent = `${fmt(result.filtered||0)} of ${fmt(totalAll)} ${esc(focusGene)} variants (${rangeLabel(range)})`;
      } catch(e) {
        $('hero-number').textContent = fmt(indexCache?.gene_breakdowns?.[focusGene]?.total || 0);
        $('hero-subtitle').textContent = `${esc(focusGene)} variants tracked`;
      }
    } else {
      $('hero-number').textContent = fmt(indexCache?.gene_breakdowns?.[focusGene]?.total || 0);
      $('hero-subtitle').textContent = `${esc(focusGene)} variants tracked`;
    }
    renderVariantList();
  } else renderHero();
};

function rangeToDate(r) {
  const d = new Date();
  if (r==='7d') d.setDate(d.getDate()-7); else if (r==='1m') d.setMonth(d.getMonth()-1);
  else if (r==='1y') d.setFullYear(d.getFullYear()-1); else if (r==='5y') d.setFullYear(d.getFullYear()-5);
  else return '';
  return d.toISOString().slice(0,10);
}
function rangeLabel(r) { return {all:'all time','5y':'5 years','1y':'1 year','1m':'1 month','7d':'7 days'}[r]||r; }

// ── Autocomplete ───────────────────────────────────────────
function onSearchInput(e) {
  const q = e.target.value.trim().toUpperCase();
  clearTimeout(searchTimeout);
  if (q.length < 1) { hideAutocomplete(); return; }
  searchTimeout = setTimeout(() => {
    if (!indexCache?.gene_breakdowns) return;
    const keys = Object.keys(indexCache.gene_breakdowns), gm = [], cm = [];
    for (const g of keys) { if (g.startsWith(q)) gm.push(g); if (gm.length>=20) break; }
    if (gm.length<20) for (const g of keys) { if (!g.startsWith(q)&&g.includes(q)) gm.push(g); if (gm.length>=20) break; }
    if (gm.length<10 && indexCache.condition_index) {
      const ql = q.toLowerCase();
      for (const c of Object.keys(indexCache.condition_index)) { if (c.toLowerCase().includes(ql)) { cm.push(c); if (cm.length>=(20-gm.length)) break; } }
    }
    showAutocomplete(gm, cm);
  }, 200);
}

function onSearchKeydown(e) {
  const items = $('autocomplete').querySelectorAll('.ac-item');
  if (!items.length) return;
  if (e.key==='ArrowDown') { e.preventDefault(); acIndex=Math.min(acIndex+1,items.length-1); items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex)); }
  else if (e.key==='ArrowUp') { e.preventDefault(); acIndex=Math.max(acIndex-1,0); items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex)); }
  else if (e.key==='Enter') { e.preventDefault(); const sel=(acIndex>=0&&items[acIndex])?items[acIndex]:(items.length===1?items[0]:null); if(sel){if(sel.dataset.condition)selectCondition(sel.dataset.condition);else if(sel.dataset.gene)selectGene(sel.dataset.gene);} }
  else if (e.key==='Escape') hideAutocomplete();
}

function showAutocomplete(genes, conds) {
  const ac = $('autocomplete'); acIndex = -1; conds = conds||[];
  if (!genes.length && !conds.length) { ac.innerHTML = '<div class="ac-item" style="color:#94a3b8;pointer-events:none">No genes found</div>'; ac.classList.add('visible'); return; }
  let h = genes.map(g => { const bd=indexCache.gene_breakdowns[g]; return `<div class="ac-item" data-gene="${esc(g)}" onclick="selectGene('${esc(g)}')"><span>${esc(g)}</span><span class="ac-count">${fmt(bd?.total||0)}</span></div>`; }).join('');
  if (conds.length) h += conds.map(c => `<div class="ac-item" data-condition="${esc(c)}" onclick="selectCondition('${esc(c)}')" style="border-left:2px solid #8b5cf6;"><span style="font-size:9px;color:#8b5cf6;">\u25C6</span> <span style="font-size:10px;">${esc(c.substring(0,50))}</span><span class="ac-count">${indexCache.condition_index[c]?.length||0} genes</span></div>`).join('');
  ac.innerHTML = h; ac.classList.add('visible');
}
function hideAutocomplete() { $('autocomplete').classList.remove('visible'); acIndex = -1; }

// ── Visualizations ─────────────────────────────────────────
function renderDrift(gene) {
  const el = $('drift-section');
  if (!el||!tracker||!loadedChunks.size) { if(el) el.innerHTML=''; return; }
  let data; try { data = JSON.parse(tracker.classification_drift(gene)); } catch(e) { el.innerHTML=''; return; }
  if (!data.snapshots?.length || data.snapshots.length<2) { el.innerHTML=''; return; }
  const snaps=data.snapshots, n=snaps.length, w=400, h=80, xStep=(w-20)/(n-1), pts=[];
  for (let i=0;i<n;i++) { const s=snaps[i], t=(s.path||0)+(s.vus||0)+(s.ben||0), x=10+i*xStep;
    if(!t){pts.push({x,pY:h-10,vY:h-10});continue;} const aH=h-20; pts.push({x,pY:10+(1-(s.path||0)/t)*aH,vY:10+(1-(s.path||0)/t-(s.vus||0)/t)*aH}); }
  const area=(up,lo)=>up.map((v,i)=>`${pts[i].x},${v}`).join(' ')+' '+[...lo].reverse().map((v,i)=>`${pts[n-1-i].x},${v}`).join(' ');
  const labels=`<text x="10" y="${h-1}" fill="#64748b" font-size="9">${snaps[0].month}</text><text x="${w/2}" y="${h-1}" text-anchor="middle" fill="#64748b" font-size="9">${snaps[Math.floor(n/2)].month}</text><text x="${w-10}" y="${h-1}" text-anchor="end" fill="#64748b" font-size="9">${snaps[n-1].month}</text>`;
  el.innerHTML = `<div class="section-title" onclick="toggleSection(this)">Classification Drift</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;" preserveAspectRatio="xMinYMin meet"><polygon points="${area(pts.map(p=>10),pts.map(p=>p.vY))}" fill="#0f766e" opacity="0.6"/><polygon points="${area(pts.map(p=>p.vY),pts.map(p=>p.pY))}" fill="#d97706" opacity="0.6"/><polygon points="${area(pts.map(p=>p.pY),pts.map(()=>h-10))}" fill="#dc2626" opacity="0.6"/>${labels}<text x="${w-10}" y="8" text-anchor="end" fill="#64748b" font-size="9"><tspan fill="#dc2626">\u25CF</tspan> path <tspan fill="#d97706">\u25CF</tspan> VUS <tspan fill="#0f766e">\u25CF</tspan> ben</text></svg></div>`;
}

function renderHotspots(gene) {
  const el = $('hotspot-section');
  if (!el||!tracker||!loadedChunks.size) { if(el) el.innerHTML=''; return; }
  let data; try { data = JSON.parse(tracker.detect_hotspots(gene, 500)); } catch(e) { el.innerHTML=''; return; }
  if (!data.length) { el.innerHTML=''; return; }
  const minP=Math.min(...data.map(d=>d.start)), maxP=Math.max(...data.map(d=>d.end)), span=maxP-minP||1, w=400, h=40;
  const blocks = data.map(d => { const x=((d.start-minP)/span)*(w-20)+10, bw=Math.max(2,((d.end-d.start)/span)*(w-20)), pf=d.total?(d.pathogenic||0)/d.total:0;
    return `<rect x="${x}" y="8" width="${bw}" height="20" rx="2" fill="rgb(${Math.round(100+pf*155)},${Math.round(60-pf*40)},${Math.round(60-pf*40)})" opacity="0.85"><title>${d.region||''}: ${d.total} variants (${d.pathogenic||0} path.)</title></rect>`; }).join('');
  el.innerHTML = `<div class="section-title" onclick="toggleSection(this)">Hotspot Map</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;" preserveAspectRatio="xMinYMin meet"><rect x="10" y="16" width="${w-20}" height="4" rx="2" fill="#e2e8f0"/>${blocks}<text x="10" y="${h-2}" fill="#64748b" font-size="9">${minP.toLocaleString()}</text><text x="${w-10}" y="${h-2}" text-anchor="end" fill="#64748b" font-size="9">${maxP.toLocaleString()}</text></svg></div>`;
}

function renderTimeline(gene) {
  const el = $('timeline-section');
  if (!el||!tracker) { if(el) el.innerHTML=''; return; }
  let tl; try { tl = JSON.parse(tracker.submissions_timeline(gene)); } catch(e) { el.innerHTML=''; return; }
  const months = tl?.months; if (!months||!Object.keys(months).length) { el.innerHTML=''; return; }
  const keys=Object.keys(months).sort(), n=keys.length, w=400, h=80, pad={l:30,r:5,t:5,b:18}, pw=w-pad.l-pad.r, ph=h-pad.t-pad.b;
  const cats = keys.map(k => { const m=months[k]; return { p:(m['path.']||0)+(m['l.path.']||0)+(m['Pathogenic']||0)+(m['Likely pathogenic']||0), v:(m['VUS']||0)+(m['Uncertain significance']||0), b:(m['benign']||0)+(m['l.ben.']||0)+(m['Benign']||0)+(m['Likely benign']||0) }; });
  cats.forEach(c => c.total = c.p+c.v+c.b);
  const maxY=Math.max(1,...cats.map(c=>c.total)), xAt=i=>pad.l+(i/Math.max(1,n-1))*pw, yAt=v=>pad.t+ph-(v/maxY)*ph;
  const ap=(up,lo)=>'M'+up.map((v,i)=>`${xAt(i)},${yAt(v)}`).join(' L')+' L'+[...lo].reverse().map((v,i)=>`${xAt(n-1-i)},${yAt(v)}`).join(' L')+' Z';
  const step=Math.max(1,Math.floor(n/5));
  const labels=keys.filter((_,i)=>i%step===0||i===n-1).map(k=>`<text x="${xAt(keys.indexOf(k))}" y="${h-2}" text-anchor="middle" fill="#64748b" font-size="9">${k.slice(2,7)}</text>`).join('');
  el.innerHTML = `<div class="section-title collapsed" onclick="toggleSection(this)">Submissions Timeline</div><div class="section-body collapsed"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px;" preserveAspectRatio="none"><path d="${ap(cats.map(c=>c.b),cats.map(()=>0))}" fill="#16a34a" opacity="0.5"/><path d="${ap(cats.map(c=>c.b+c.v),cats.map(c=>c.b))}" fill="#eab308" opacity="0.5"/><path d="${ap(cats.map(c=>c.total),cats.map(c=>c.b+c.v))}" fill="#dc2626" opacity="0.5"/>${labels}<text x="${pad.l-3}" y="${pad.t+4}" text-anchor="end" fill="#64748b" font-size="9">${maxY}</text><text x="${pad.l-3}" y="${yAt(0)+1}" text-anchor="end" fill="#64748b" font-size="9">0</text></svg></div>`;
}

function renderConcordance(gene) {
  const el = $('concordance-section');
  if (!el||!tracker||!loadedChunks.size) { if(el) el.innerHTML=''; return; }
  let data; try { data = JSON.parse(tracker.concordance_analysis(gene)); } catch(e) { el.innerHTML=''; return; }
  if (!data.length) { el.innerHTML=''; return; }
  const rows = data.slice(0,20).map(r => { const s=r.discordance_score||0, bW=Math.round(s*60), red=Math.round(s*220+35), grn=Math.round((1-s)*180+40);
    return `<tr><td style="font-size:9px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.hgvs)}">${esc(r.hgvs)}</td><td><span class="badge-sm ${badgeClass(r.classification)}">${esc(r.classification)}</span></td><td style="font-size:8px;color:#64748b;">${esc(r.submitter)}</td><td><svg width="64" height="10" style="vertical-align:middle;"><rect x="0" y="1" width="${bW}" height="8" rx="2" fill="rgb(${red},${grn},60)"/><rect x="0" y="1" width="60" height="8" rx="2" fill="none" stroke="#e2e8f0" stroke-width="0.5"/></svg></td></tr>`; }).join('');
  el.innerHTML = `<div class="section-title collapsed" onclick="toggleSection(this)">Submitter Concordance</div><div class="section-body collapsed"><table style="width:100%;border-collapse:collapse;font-size:9px;"><thead><tr style="color:#94a3b8;text-align:left;"><th>Variant</th><th>Class</th><th>Submitters</th><th>Discordance</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderSurvival(gene) {
  const el = $('survival-section');
  if (!el||!tracker) { if(el) el.innerHTML=''; return; }
  let curve; try { curve = JSON.parse(tracker.vus_survival_curve(gene)); } catch(e) { el.innerHTML=''; return; }
  const pts = curve.points||curve; if (!pts?.length) { el.innerHTML=''; return; }
  const w=400, h=100, pad={l:30,r:10,t:10,b:20}, pw=w-pad.l-pad.r, ph=h-pad.t-pad.b;
  const maxX=Math.max(1,pts[pts.length-1].days||pts[pts.length-1].x||1);
  const xAt=d=>pad.l+(d/maxX)*pw, yAt=f=>pad.t+ph-f*ph;
  const line=pts.map(p=>`${xAt(p.days??p.x)},${yAt(p.fraction??p.y)}`).join(' L');
  const circles=pts.filter((_,i)=>i%Math.max(1,Math.floor(pts.length/20))===0).map(p=>{const d=p.days??p.x,f=p.fraction??p.y;return `<circle cx="${xAt(d)}" cy="${yAt(f)}" r="3" fill="#0f766e" opacity="0"><title>Day ${d}: ${(f*100).toFixed(1)}% still VUS</title></circle><circle cx="${xAt(d)}" cy="${yAt(f)}" r="8" fill="transparent"><title>Day ${d}: ${(f*100).toFixed(1)}% still VUS</title></circle>`;}).join('');
  const xL=[0,Math.round(maxX/2),maxX].map(d=>`<text x="${xAt(d)}" y="${h-3}" text-anchor="middle" fill="#64748b" font-size="9">${d}d</text>`).join('');
  const yL=[0,0.5,1].map(f=>`<text x="${pad.l-3}" y="${yAt(f)+2}" text-anchor="end" fill="#64748b" font-size="9">${f}</text>`).join('');
  const grid=[0.25,0.5,0.75].map(f=>`<line x1="${pad.l}" y1="${yAt(f)}" x2="${w-pad.r}" y2="${yAt(f)}" stroke="#f1f5f9" stroke-width="0.5"/>`).join('');
  el.innerHTML = `<div class="section-title collapsed" onclick="toggleSection(this)">VUS Survival Curve</div><div class="section-body collapsed"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100px;">${grid}<polyline points="${line}" fill="none" stroke="#0f766e" stroke-width="1.5"/>${circles}${xL}${yL}<text x="${w/2}" y="${h}" text-anchor="middle" fill="#64748b" font-size="9">days since VUS submission</text></svg></div>`;
}

function renderGenomeBrowser(containerId, gene) {
  const el = document.getElementById(containerId);
  if (!el || !tracker || !focusGene) { if (el) el.innerHTML = ''; return; }

  // Get all variants for this gene with positions
  let result;
  try {
    result = JSON.parse(tracker.query(JSON.stringify({
      gene: gene, limit: 5000, sort_by: 'position', sort_asc: true
    })));
  } catch(e) { el.innerHTML = ''; return; }
  const variants = (result.variants || []).filter(v => v.pos > 0);
  if (!variants.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:9px">No genomic coordinates available</div>'; return; }

  // Determine genomic range
  const minPos = variants[0].pos;
  const maxPos = variants[variants.length - 1].pos;
  const span = maxPos - minPos || 1;
  const chrom = variants[0].chrom || '?';

  // State for zoom/pan
  let viewStart = minPos - span * 0.05;
  let viewEnd = maxPos + span * 0.05;

  function render() {
    const viewSpan = viewEnd - viewStart;
    const w = 400, h = 70;

    const classColor = (c) => {
      const s = shortClass(c);
      if (s.includes('path')) return '#dc2626';
      if (s === 'VUS') return '#eab308';
      if (s.includes('ben')) return '#16a34a';
      if (s.includes('confl')) return '#8b5cf6';
      return '#94a3b8';
    };

    const toX = (pos) => ((pos - viewStart) / viewSpan) * w;

    let variantSVG = '';
    const visible = variants.filter(v => v.pos >= viewStart && v.pos <= viewEnd);

    if (visible.length > 200) {
      // Density heatmap mode
      const bins = new Array(w).fill(null).map(() => ({path:0, vus:0, ben:0, total:0}));
      for (const v of visible) {
        const x = Math.floor(toX(v.pos));
        if (x >= 0 && x < w) {
          bins[x].total++;
          const s = shortClass(v.classification);
          if (s.includes('path')) bins[x].path++;
          else if (s === 'VUS') bins[x].vus++;
          else bins[x].ben++;
        }
      }
      for (let x = 0; x < w; x++) {
        if (bins[x].total === 0) continue;
        const intensity = Math.min(bins[x].total / 5, 1);
        const mainColor = bins[x].path > bins[x].vus ? '#dc2626' : bins[x].vus > bins[x].ben ? '#eab308' : '#16a34a';
        variantSVG += `<rect x="${x}" y="${20}" width="1" height="${30 * intensity + 5}" fill="${mainColor}" opacity="${0.3 + intensity * 0.7}"><title>${bins[x].total} variants at chr${chrom}:${Math.round(viewStart + (x/w)*viewSpan)}</title></rect>`;
      }
    } else {
      // Lollipop mode
      for (const v of visible) {
        const x = toX(v.pos).toFixed(1);
        const color = classColor(v.classification);
        const sc = shortClass(v.classification);
        variantSVG += `<line x1="${x}" y1="50" x2="${x}" y2="25" stroke="${color}" stroke-width="1" opacity="0.6"/>`;
        variantSVG += `<circle cx="${x}" cy="22" r="3" fill="${color}" opacity="0.8"><title>${v.gene} ${v.hgvs} (${sc})\nchr${chrom}:${v.pos}</title></circle>`;
      }
    }

    // Axis ticks
    const ticks = 5;
    let axisSVG = '';
    for (let i = 0; i <= ticks; i++) {
      const pos = viewStart + (viewSpan * i / ticks);
      const x = (i / ticks) * w;
      const label = pos >= 1e6 ? (pos/1e6).toFixed(2) + 'M' : pos >= 1e3 ? (pos/1e3).toFixed(0) + 'K' : pos.toFixed(0);
      axisSVG += `<line x1="${x}" y1="55" x2="${x}" y2="58" stroke="#cbd5e1" stroke-width="0.5"/>`;
      axisSVG += `<text x="${x}" y="66" text-anchor="middle" fill="#64748b" font-size="7">${label}</text>`;
    }

    // Navigation controls
    const controls = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
        <span style="font-size:8px;color:#64748b;">chr${chrom}:${Math.round(viewStart)}\u2013${Math.round(viewEnd)} (${visible.length} variants)</span>
        <span style="display:flex;gap:2px;">
          <button onclick="browserZoom(0.5)" style="font-size:9px;padding:1px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;cursor:pointer;">+</button>
          <button onclick="browserZoom(2)" style="font-size:9px;padding:1px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;cursor:pointer;">\u2212</button>
          <button onclick="browserPan(-0.3)" style="font-size:9px;padding:1px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;cursor:pointer;">\u2190</button>
          <button onclick="browserPan(0.3)" style="font-size:9px;padding:1px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;cursor:pointer;">\u2192</button>
          <button onclick="browserReset()" style="font-size:9px;padding:1px 4px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;cursor:pointer;">\u27F2</button>
        </span>
      </div>
    `;

    // Gene track bar
    const geneBar = `<rect x="0" y="12" width="${w}" height="4" rx="2" fill="#e2e8f0"/>
      <rect x="${toX(minPos)}" y="12" width="${Math.max(toX(maxPos) - toX(minPos), 2)}" height="4" rx="2" fill="#0f766e" opacity="0.3"/>
      <text x="${toX(minPos)}" y="9" fill="#0f766e" font-size="8" font-weight="600">${gene}</text>`;

    el.innerHTML = controls + `
      <svg viewBox="0 0 ${w} 70" style="width:100%;height:70px;">
        ${geneBar}
        ${variantSVG}
        <line x1="0" y1="55" x2="${w}" y2="55" stroke="#e2e8f0" stroke-width="0.5"/>
        ${axisSVG}
      </svg>
    `;
  }

  // Zoom/Pan controls
  window.browserZoom = function(factor) {
    const center = (viewStart + viewEnd) / 2;
    const halfSpan = ((viewEnd - viewStart) / 2) * factor;
    viewStart = center - halfSpan;
    viewEnd = center + halfSpan;
    render();
  };

  window.browserPan = function(fraction) {
    const shift = (viewEnd - viewStart) * fraction;
    viewStart += shift;
    viewEnd += shift;
    render();
  };

  window.browserReset = function() {
    viewStart = minPos - span * 0.05;
    viewEnd = maxPos + span * 0.05;
    render();
  };

  // Mouse wheel zoom
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.3 : 0.7;
    const rect = el.querySelector('svg')?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = (e.clientX - rect.left) / rect.width;
    const mousePos = viewStart + mouseX * (viewEnd - viewStart);
    viewStart = mousePos - (mousePos - viewStart) * factor;
    viewEnd = mousePos + (viewEnd - mousePos) * factor;
    render();
  }, { passive: false });

  render();
}

function renderIdeogram() {
  const el = $('ideogram-section'); if (!el) return;
  const bins = indexCache?.chromosome_bins; if (!bins) { el.innerHTML=''; return; }
  const cL={chr1:248,chr2:242,chr3:198,chr4:190,chr5:181,chr6:170,chr7:159,chr8:145,chr9:138,chr10:133,chr11:135,chr12:133,chr13:114,chr14:107,chr15:101,chr16:90,chr17:83,chr18:80,chr19:58,chr20:64,chr21:46,chr22:50,chrX:156,chrY:57};
  const chrOrder=Object.keys(cL), maxLen=248, w=400, h=120, barW=12, gap=(w-10)/chrOrder.length;
  let maxCount=1; for (const chr of chrOrder) { const cb=bins[chr]; if(cb) Object.values(cb).forEach(v=>{if(v>maxCount)maxCount=v;}); }
  const elems = chrOrder.map((chr,i) => { const x=5+i*gap, chrH=(cL[chr]/maxLen)*(h-30), y0=h-16-chrH, cb=bins[chr]||{};
    let p=`<rect x="${x}" y="${y0}" width="${barW}" height="${chrH}" rx="3" fill="#f1f5f9" stroke="#e2e8f0" stroke-width="0.5"/>`;
    for (const pos of Object.keys(cb).map(Number).sort((a,b)=>a-b)) { const c=cb[pos],f=c/maxCount,by=y0+(pos/(cL[chr]*1e6||1))*chrH,bh=Math.max(1,(1/(cL[chr]||1))*chrH);
      p+=`<rect x="${x}" y="${by}" width="${barW}" height="${bh}" fill="rgb(${15-Math.round(f*15)},${118-Math.round(f*48)},${110-Math.round(f*40)})" opacity="${0.3+f*0.7}"><title>${chr}:${pos} \u2014 ${c} variants</title></rect>`; }
    return p+`<rect x="${x}" y="${y0}" width="${barW}" height="${chrH}" fill="transparent" style="cursor:pointer;" onclick="zoomChromosome('${chr}')"/><text x="${x+barW/2}" y="${h-4}" text-anchor="middle" fill="#64748b" font-size="9" style="cursor:pointer;" onclick="zoomChromosome('${chr}')">${chr.replace('chr','')}</text>`; }).join('');
  el.innerHTML = `<div class="section-title" onclick="toggleSection(this)">Chromosome Ideogram</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;cursor:pointer;" preserveAspectRatio="xMinYMin meet">${elems}</svg><div id="ideogram-zoom" style="display:none;margin-top:4px;"></div></div>`;
}

window.zoomChromosome = function(chr) {
  const el = document.getElementById('ideogram-zoom');
  if (!el || !indexCache?.chromosome_bins) return;
  const cb = indexCache.chromosome_bins[chr];
  if (!cb || !Object.keys(cb).length) { el.style.display='none'; return; }

  // If already showing this chromosome, toggle off
  if (el.dataset.chr === chr) { el.style.display='none'; el.dataset.chr=''; return; }
  el.dataset.chr = chr;
  el.style.display = 'block';

  const cL={chr1:248,chr2:242,chr3:198,chr4:190,chr5:181,chr6:170,chr7:159,chr8:145,chr9:138,chr10:133,chr11:135,chr12:133,chr13:114,chr14:107,chr15:101,chr16:90,chr17:83,chr18:80,chr19:58,chr20:64,chr21:46,chr22:50,chrX:156,chrY:57};
  const chrLen = (cL[chr] || 100) * 1e6;
  const positions = Object.keys(cb).map(Number).sort((a,b) => a - b);
  const w = 400, h = 50, pad = 10;

  let maxCount = 1;
  for (const p of positions) { if (cb[p] > maxCount) maxCount = cb[p]; }

  // Draw expanded chromosome with density bars
  const toX = (pos) => pad + ((pos / chrLen) * (w - 2 * pad));
  let bars = '';
  for (const pos of positions) {
    const x = toX(pos);
    const count = cb[pos];
    const f = count / maxCount;
    const barH = 4 + f * 26;
    bars += `<rect x="${x - 1}" y="${30 - barH}" width="3" height="${barH}" rx="1" fill="rgb(${15 + Math.round(f * 200)},${118 - Math.round(f * 80)},${110 - Math.round(f * 70)})" opacity="${0.4 + f * 0.6}"><title>${chr}:${pos.toLocaleString()} \u2014 ${count} variants</title></rect>`;
  }

  // Axis labels
  const axisLabels = [0, 0.25, 0.5, 0.75, 1].map(frac => {
    const pos = Math.round(chrLen * frac);
    const x = pad + frac * (w - 2 * pad);
    const label = pos >= 1e6 ? (pos/1e6).toFixed(0) + 'M' : (pos/1e3).toFixed(0) + 'K';
    return `<text x="${x}" y="${h - 2}" text-anchor="middle" fill="#64748b" font-size="8">${label}</text>`;
  }).join('');

  el.innerHTML = `<div style="font-size:9px;color:#0f766e;font-weight:600;margin-bottom:2px;">${chr} expanded <span style="color:#94a3b8;font-weight:normal;cursor:pointer;" onclick="document.getElementById('ideogram-zoom').style.display='none';document.getElementById('ideogram-zoom').dataset.chr='';">\u2715</span></div>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;" preserveAspectRatio="xMinYMin meet">
      <rect x="${pad}" y="28" width="${w - 2*pad}" height="4" rx="2" fill="#e2e8f0"/>
      ${bars}
      <line x1="${pad}" y1="35" x2="${w - pad}" y2="35" stroke="#e2e8f0" stroke-width="0.5"/>
      ${axisLabels}
    </svg>`;
};

// ── Report Date ────────────────────────────────────────────
function onReportDate(e) {
  const date=e.target.value; if (!date||!tracker) return;
  const gene=currentFilters.gene||focusGene||'';
  let result; try { result = JSON.parse(tracker.changes_since(gene, date)); } catch(e) { return; }
  const el=$('variant-list'), gl=gene||'all genes';
  if (result.total===0) { el.innerHTML=`<div style="color:#16a34a;font-size:11px;padding:8px 0;">No changes for ${esc(gl)} since ${esc(date)}. Findings still current.</div>`; }
  else { let h=`<div style="color:#dc2626;font-size:11px;padding:4px 0;font-weight:600;">${result.total} change${result.total>1?'s':''} for ${esc(gl)} since ${esc(date)}:</div>`;
    (result.changes||[]).forEach(c=>{h+=`<div class="variant-row"><span class="gene">${esc(c.gene)}</span><span class="hgvs">${esc((c.hgvs||'').substring(0,30))}</span><span class="val" style="font-size:9px;">${shortClass(c.old)} \u2192 ${shortClass(c.new)}</span></div>`;});
    el.innerHTML=h+'<div style="color:#94a3b8;font-size:9px;margin-top:6px;">Computational observations. Verify with original ClinVar record.</div>'; }
}

// ── VCF Upload ─────────────────────────────────────────────
function setupVCFDrop() {
  const drop=$('vcf-drop'), input=$('vcf-input'); if (!drop||!input) return;
  drop.addEventListener('dragover', e=>{e.preventDefault();drop.style.borderColor='#0f766e';});
  drop.addEventListener('dragleave', ()=>{drop.style.borderColor='#e2e8f0';});
  drop.addEventListener('drop', e=>{e.preventDefault();drop.style.borderColor='#e2e8f0';if(e.dataTransfer.files.length)processVCF(e.dataTransfer.files[0]);});
  input.addEventListener('change', ()=>{if(input.files.length)processVCF(input.files[0]);});
}

async function processVCF(file) {
  const res=$('vcf-results'); res.style.display='block'; res.innerHTML='<div style="color:#94a3b8">Parsing VCF locally...</div>';
  const match = JSON.parse(tracker.match_vcf(await file.text()));
  let h=`<div class="row"><span>Total VCF variants</span><span class="val">${match.total_vcf_variants}</span></div><div class="row"><span>Matched in ClinVar</span><span class="val">${match.matched_count}</span></div><div class="row"><span>Not in ClinVar</span><span class="val">${match.unmatched_count}</span></div><div class="row"><span class="badge-sm badge-path">Pathogenic</span><span class="val">${match.pathogenic?.length||0}</span></div><div class="row"><span class="badge-sm badge-vus">VUS</span><span class="val">${match.vus?.length||0}</span></div><div class="row"><span class="badge-sm badge-benign">Benign</span><span class="val">${match.benign?.length||0}</span></div>`;
  if (match.pathogenic?.length) { h+='<div class="section-title" style="margin-top:8px">Pathogenic</div>'; match.pathogenic.slice(0,20).forEach(m=>{h+=`<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0,25)}</span><span class="badge-sm badge-path">path.</span></div>`;}); }
  if (match.vus?.length) { h+='<div class="section-title" style="margin-top:8px">VUS</div>'; match.vus.slice(0,20).forEach(m=>{h+=`<div class="row"><span class="gene">${esc(m.gene)}</span><span class="hgvs">${esc(m.hgvs).substring(0,25)}</span><span class="badge-sm badge-vus">VUS</span></div>`;}); }
  res.innerHTML = h;
}

// ── Export ──────────────────────────────────────────────────
function buildExport(what, sep) {
  if (!indexCache) return '';
  const gene=focusGene||'LDLR'; let out='';
  if (what==='focus'||what==='all') {
    const genes=what==='all'?Object.keys(indexCache.gene_breakdowns||{}):[gene];
    out+=`Gene${sep}Total${sep}Pathogenic${sep}Likely Path.${sep}VUS${sep}Likely Benign${sep}Benign${sep}Conflicting\n`;
    genes.forEach(g=>{const d=indexCache.gene_breakdowns?.[g];if(d) out+=`${g}${sep}${d.total}${sep}${d.pathogenic}${sep}${d.likely_pathogenic}${sep}${d.vus}${sep}${d.likely_benign}${sep}${d.benign}${sep}${d.conflicting}\n`;});
  }
  if (what==='changes'&&tracker) { out+=`Gene${sep}HGVS${sep}Old${sep}New${sep}Date${sep}Submitter\n`; try{const r=JSON.parse(tracker.changes_since('','1900-01-01'));(r.changes||[]).forEach(c=>{out+=`${c.gene}${sep}${(c.hgvs||'').replace(/,/g,';')}${sep}${c.old}${sep}${c.new}${sep}${c.detected_at}${sep}${(c.submitter||'').replace(/,/g,';')}\n`;});}catch(e){} }
  if (what==='top') { out+=`Gene${sep}Variants\n`; (indexCache.top_genes||[]).forEach(([n,c])=>{out+=`${n}${sep}${c}\n`;}); }
  return out+`\nGenerated by nano-zyrkel-vusTracker \u00B7 Data: NCBI ClinVar (public domain)\n`;
}

window.doExport = function(format) {
  const what=$('export-what').value, gene=focusGene||'LDLR', date=new Date().toISOString().slice(0,10), label=what==='focus'?gene:what;
  const dl=(c,f,m)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([c],{type:m}));a.download=f;a.click();};
  if (format==='csv') dl(buildExport(what,','),`vusTracker_${label}_${date}.csv`,'text/csv');
  else if (format==='tsv') dl(buildExport(what,'\t'),`vusTracker_${label}_${date}.tsv`,'text/tab-separated-values');
  else if (format==='xls') {
    const rows=buildExport(what,'\t').split('\n').filter(l=>l).map(line=>'<Row>'+line.split('\t').map(c=>`<Cell><Data ss:Type="${isNaN(c)||c===''?'String':'Number'}">${c.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Data></Cell>`).join('')+'</Row>').join('');
    dl(`<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${label}"><Table>${rows}</Table></Worksheet></Workbook>`,`vusTracker_${label}_${date}.xls`,'application/vnd.ms-excel');
  }
};

window.shareLink = function() {
  const url=window.location.href;
  if (navigator.share) navigator.share({title:`ClinVar ${focusGene} \u2014 vusTracker`,url});
  else navigator.clipboard.writeText(url).then(()=>alert('Link copied!'));
};

// ── Helpers ────────────────────────────────────────────────
function showLoading(msg) { $('loading-text').textContent=msg||'loading...'; $('loading').style.display='block'; }
function hideLoading() { $('loading').style.display='none'; }
function fmt(n) { if(n>=1e6) return (n/1e6).toFixed(1)+'M'; return Number(n).toLocaleString('en-US'); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function badgeClass(c) { const s=shortClass(c); return {'path.':'badge-path','l.path.':'badge-lpath','VUS':'badge-vus','l.ben.':'badge-lben','benign':'badge-benign','confl.':'badge-confl'}[s]||''; }

function shortClass(c) {
  if (!c) return '?';
  if (typeof c === 'object') {
    if ('Pathogenic' in c||c==='Pathogenic') return 'path.'; if ('LikelyPathogenic' in c||c==='LikelyPathogenic') return 'l.path.';
    if ('Vus' in c||c==='Vus') return 'VUS'; if ('LikelyBenign' in c||c==='LikelyBenign') return 'l.ben.';
    if ('Benign' in c||c==='Benign') return 'benign'; if ('ConflictingInterpretations' in c||c==='ConflictingInterpretations') return 'confl.';
    if ('Other' in c) return c.Other||'?'; return JSON.stringify(c).substring(0,8);
  }
  const l=String(c).toLowerCase();
  if (l.includes('pathogenic')&&l.includes('likely')) return 'l.path.'; if (l.includes('pathogenic')) return 'path.';
  if (l.includes('uncertain')||l==='vus') return 'VUS'; if (l.includes('benign')&&l.includes('likely')) return 'l.ben.';
  if (l.includes('benign')) return 'benign'; if (l.includes('conflicting')) return 'confl.'; return '?';
}

if (new URLSearchParams(window.location.search).get('embed')==='true') document.body.classList.add('embed');
init();
