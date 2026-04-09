const API_BASE = 'https://vus.zyrkel.com/api/v1';
const API_KEY = '781a2daba1bac1a74bcf3e58a630732fb3a63fec9dcb232b623e4cc5c8491ec4';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  mode: 'overview',
  stats: null,
  genes: [],
  selectedGene: null,
  geneData: {},
  variants: [],
  variantsMeta: {},
  timeRange: '1m',
  activeFilters: new Set(['pathogenic', 'likely_pathogenic', 'uncertain_significance', 'likely_benign', 'benign']),
  variantPage: 1,
  searchResults: null,
  searchTimeout: null,
  genomeBrowser: { zoom: 1, panX: 0, dragging: false, lastX: 0 },
  hgvsFilter: '',
  codingFilter: 'all', // 'all', 'coding', 'noncoding'
  positionFrom: '',
  positionTo: '',
  expandedVariants: new Set(),
  searchMode: 'gene', // 'gene' or 'phenotype'
  topConditions: [],
  conditionListPage: 0,
  phenotypeResults: null,
  phenotypeGenes: null,
  selectedHpoTerms: [],
  geneListPage: 0,
  openSection: null, // track which section is open to preserve on re-render
};

// ── API helper ─────────────────────────────────────────────────────────────
async function api(path, params = {}) {
  params.api_key = API_KEY;
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

// ── Date helpers ───────────────────────────────────────────────────────────
function dateFrom(range) {
  if (range === 'all') return null;
  const d = new Date();
  if (range === '7d') d.setDate(d.getDate() - 7);
  else if (range === '1m') d.setMonth(d.getMonth() - 1);
  else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
  else if (range === '5y') d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().split('T')[0];
}

// ── Number animation ───────────────────────────────────────────────────────
function animateNumber(el, target, duration = 800) {
  const start = parseInt(el.textContent.replace(/,/g, '')) || 0;
  if (start === target) return;
  const startTime = performance.now();
  function tick(now) {
    const p = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (target - start) * eased).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Render helpers ─────────────────────────────────────────────────────────
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'innerHTML') el.innerHTML = v;
    else if (k === 'disabled') { if (v) el.setAttribute('disabled', ''); else el.removeAttribute('disabled'); }
    else el.setAttribute(k, v);
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function clear(el) { el.innerHTML = ''; }

// ── Classification colors & labels ─────────────────────────────────────────
const CLASS_COLORS = {
  pathogenic: '#EF4444', likely_pathogenic: '#F97316',
  uncertain_significance: '#EAB308', likely_benign: '#22C55E', benign: '#3B82F6',
};
const CLASS_SHORT = {
  pathogenic: 'Path', likely_pathogenic: 'LP',
  uncertain_significance: 'VUS', likely_benign: 'LB', benign: 'Ben',
};
const CLASS_CSS = {
  pathogenic: 'path', likely_pathogenic: 'lp',
  uncertain_significance: 'vus', likely_benign: 'lb', benign: 'ben',
};

// ── Main render ────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  const prevScroll = app.querySelector('.widget')?.scrollTop || 0;
  clear(app);
  const widget = h('div', { className: 'widget' });

  // Header
  widget.appendChild(renderHeader());

  // Search
  widget.appendChild(renderSearch());

  const content = h('div', { className: 'widget-content' });
  if (state.mode === 'overview') {
    content.appendChild(renderOverview());
  } else {
    content.appendChild(renderGeneDetail());
  }
  widget.appendChild(content);

  // Footer
  widget.appendChild(h('div', { className: 'widget-footer' }, [
    h('div', {}, [
      h('span', {}, 'Auto-updates daily from '),
      h('a', { href: 'https://www.ncbi.nlm.nih.gov/clinvar/', target: '_blank' }, 'ClinVar'),
      h('span', {}, ', '),
      h('a', { href: 'https://hpo.jax.org/', target: '_blank' }, 'HPO'),
      h('span', {}, ', '),
      h('a', { href: 'https://omim.org/', target: '_blank' }, 'OMIM'),
    ]),
    h('div', { style: { marginTop: '2px' } }, [
      h('span', {}, 'Powered by '),
      h('a', { href: 'https://github.com/schlein-lab', target: '_blank' }, 'nano-zyrkel'),
      h('span', {}, ' \u00B7 '),
      h('a', { href: 'https://zyrkel.com', target: '_blank' }, 'zyrkel.com'),
    ]),
  ]));

  app.appendChild(widget);
  if (prevScroll) widget.scrollTop = prevScroll;
}

function renderHeader() {
  const banner = h('div', { className: 'widget-banner' }, [
    h('img', { src: 'header.png', alt: '', className: 'banner-img' }),
    h('div', { className: 'banner-overlay' }, [
      h('div', { className: 'banner-title' }, 'VUS Tracker'),
      h('div', { className: 'banner-subtitle' }, 'Variant Intelligence Platform'),
    ]),
  ]);
  const logo = h('div', { className: 'widget-logo' }, [
    h('span', { style: { fontSize: '10px', color: 'var(--text-secondary)' } }, 'Powered by nano-zyrkel'),
  ]);
  const actions = h('div', { className: 'header-actions' });

  if (state.mode === 'gene' && state.variants.length > 0) {
    const csvBtn = h('button', {
      className: 'icon-btn', title: 'Export CSV',
      onClick: () => exportData('csv'),
      innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    });
    const tsvBtn = h('button', {
      className: 'icon-btn', title: 'Export TSV',
      onClick: () => exportData('tsv'),
      innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>',
    });
    actions.appendChild(csvBtn);
    actions.appendChild(tsvBtn);
  }

  const hdr = h('div', { className: 'widget-header' });
  hdr.appendChild(banner);
  const bottomRow = h('div', { className: 'header-bottom' });
  bottomRow.appendChild(logo);
  bottomRow.appendChild(actions);
  hdr.appendChild(bottomRow);
  return hdr;
}

// ── Search ─────────────────────────────────────────────────────────────────
function renderSearch() {
  const outer = h('div');

  // Search mode toggle
  const modeRow = h('div', { className: 'search-mode-toggle' });
  const geneBtn = h('button', {
    className: `search-mode-btn${state.searchMode === 'gene' ? ' active' : ''}`,
    onClick: () => { state.searchMode = 'gene'; state.phenotypeResults = null; state.phenotypeGenes = null; state.selectedHpoTerms = []; render(); },
  }, 'Gene');
  const phenoBtn = h('button', {
    className: `search-mode-btn${state.searchMode === 'phenotype' ? ' active' : ''}`,
    onClick: () => { state.searchMode = 'phenotype'; state.searchResults = null; render(); },
  }, 'Phenotype');
  modeRow.appendChild(geneBtn);
  modeRow.appendChild(phenoBtn);

  const wrap = h('div', { className: 'search-wrap' });
  const icon = h('span', { className: 'search-icon', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' });
  const placeholder = state.searchMode === 'gene' ? 'Gene symbol (e.g. BRCA2, RYR2, SCN5A)' : 'Phenotype (e.g. telecanthus, ptosis, microcephaly)';
  const dropdown = h('div', { className: 'search-dropdown' });
  const input = h('input', {
    className: 'search-input', type: 'text', placeholder,
    onInput: (e) => {
      if (state.searchMode === 'gene') handleSearch(e.target.value, dropdown);
      else handlePhenotypeSearch(e.target.value, dropdown);
    },
    onFocus: () => { if (state.searchResults || state.phenotypeResults) dropdown.classList.add('open'); },
    onBlur: () => { setTimeout(() => dropdown.classList.remove('open'), 200); },
  });
  wrap.appendChild(icon);
  wrap.appendChild(input);
  wrap.appendChild(dropdown);
  outer.appendChild(wrap);
  outer.appendChild(modeRow);

  // Show selected HPO terms and gene results
  if (state.searchMode === 'phenotype') {
    if (state.selectedHpoTerms.length > 0) {
      const tagsRow = h('div', { className: 'hpo-tags' });
      for (const term of state.selectedHpoTerms) {
        const tag = h('span', { className: 'hpo-tag' }, [
          h('span', {}, `${term.name} (${term.hpo_id})`),
          h('span', { className: 'hpo-tag-remove', onClick: () => {
            state.selectedHpoTerms = state.selectedHpoTerms.filter(t => t.hpo_id !== term.hpo_id);
            if (state.selectedHpoTerms.length > 0) loadPhenotypeGenes();
            else { state.phenotypeGenes = null; render(); }
          }}, ' \u00D7'),
        ]);
        tagsRow.appendChild(tag);
      }
      outer.appendChild(tagsRow);
    }
    if (state.phenotypeGenes && state.phenotypeGenes.length > 0) {
      const geneList = h('div', { className: 'pheno-gene-list' });
      // Clear back button
      geneList.appendChild(h('button', {
        className: 'back-btn', style: { marginBottom: '6px' },
        onClick: () => { state.selectedHpoTerms = []; state.phenotypeGenes = null; render(); },
      }, '\u2190 Back to Top Phenotypes'));
      geneList.appendChild(h('div', { className: 'gene-list-title' }, `${state.phenotypeGenes.length} genes matching phenotype`));
      for (const g of state.phenotypeGenes.slice(0, 20)) {
        const diseases = (g.diseases || []).slice(0, 3).map(d =>
          h('a', { href: d.startsWith('OMIM:') ? `https://omim.org/entry/${d.replace('OMIM:', '')}` : d.startsWith('ORPHA:') ? `https://www.orpha.net/en/disease/detail/${d.replace('ORPHA:', '')}` : '#', target: '_blank', className: 'pheno-link', style: { fontSize: '10px' } }, d)
        );
        const row = h('div', { className: 'gene-row', onClick: () => selectGene(g.gene_symbol) }, [
          h('span', { className: 'gene-name' }, g.gene_symbol),
          h('span', { className: 'gene-vus-count' }, `${g.match_count || 0}/${state.selectedHpoTerms.length}`),
          h('span', { className: 'pheno-diseases' }, diseases),
        ]);
        geneList.appendChild(row);
      }
      outer.appendChild(geneList);
    } else if (state.phenotypeGenes !== null && state.phenotypeGenes.length === 0) {
      outer.appendChild(h('button', {
        className: 'back-btn', style: { marginBottom: '6px' },
        onClick: () => { state.selectedHpoTerms = []; state.phenotypeGenes = null; render(); },
      }, '\u2190 Back to Top Phenotypes'));
      outer.appendChild(h('div', { className: 'empty-state' }, 'No genes found for selected phenotypes'));
    }
  }

  return outer;
}

async function handleSearch(query, dropdown) {
  clearTimeout(state.searchTimeout);
  if (query.length < 2) {
    dropdown.classList.remove('open');
    state.searchResults = null;
    return;
  }
  state.searchTimeout = setTimeout(async () => {
    try {
      const res = await api('/search', { q: query });
      state.searchResults = res.data;
      clear(dropdown);
      const genes = res.data.genes || [];
      if (genes.length === 0) {
        dropdown.appendChild(h('div', { className: 'empty-state' }, 'No results'));
      } else {
        for (const g of genes.slice(0, 8)) {
          const row = h('div', { className: 'search-item', onClick: () => selectGene(g.symbol) }, [
            h('span', { className: 'gene-sym' }, g.symbol),
            h('span', { className: 'gene-count' }, `${g.vus_count || g.total_variants || 0} variants`),
          ]);
          dropdown.appendChild(row);
        }
      }
      dropdown.classList.add('open');
    } catch (e) {
      console.error('Search error:', e);
    }
  }, 300);
}

async function handlePhenotypeSearch(query, dropdown) {
  clearTimeout(state.searchTimeout);
  if (query.length < 2) {
    dropdown.classList.remove('open');
    state.phenotypeResults = null;
    return;
  }
  state.searchTimeout = setTimeout(async () => {
    try {
      const res = await api('/phenotype/search', { q: query });
      state.phenotypeResults = res.data || [];
      clear(dropdown);
      if (state.phenotypeResults.length === 0) {
        dropdown.appendChild(h('div', { className: 'empty-state' }, 'No phenotypes found'));
      } else {
        for (const p of state.phenotypeResults.slice(0, 8)) {
          const row = h('div', { className: 'search-item', onClick: () => {
            if (!state.selectedHpoTerms.find(t => t.hpo_id === p.hpo_id)) {
              state.selectedHpoTerms.push(p);
              loadPhenotypeGenes();
            }
            dropdown.classList.remove('open');
          }}, [
            h('span', { className: 'gene-sym' }, p.hpo_id),
            h('span', { className: 'gene-count' }, p.name),
            h('span', { className: 'gene-count' }, `${p.gene_count || 0} genes`),
          ]);
          dropdown.appendChild(row);
        }
      }
      dropdown.classList.add('open');
    } catch (e) {
      console.error('Phenotype search error:', e);
    }
  }, 300);
}

async function handlePhenotypeSearchDirect(query) {
  try {
    const res = await api('/phenotype/search', { q: query });
    const results = res.data || [];
    if (results.length > 0) {
      const term = results[0];
      if (!state.selectedHpoTerms.find(t => t.hpo_id === term.hpo_id)) {
        state.selectedHpoTerms.push(term);
        loadPhenotypeGenes();
      }
    }
  } catch (e) { console.error('Direct phenotype search error:', e); }
  render();
}

async function loadPhenotypeGenes() {
  if (state.selectedHpoTerms.length === 0) { state.phenotypeGenes = null; render(); return; }
  try {
    const hpoIds = state.selectedHpoTerms.map(t => t.hpo_id).join(',');
    const res = await api('/phenotype/genes', { hpo: hpoIds });
    state.phenotypeGenes = res.data || [];
  } catch (e) {
    console.error('Phenotype genes error:', e);
    state.phenotypeGenes = [];
  }
  render();
}

// ── Overview Mode ──────────────────────────────────────────────────────────
function renderOverview() {
  const container = h('div');

  // Big stat
  const statBox = h('div', { className: 'big-stat' });
  const numEl = h('div', { className: 'big-number animate-in' }, '0');
  const subEl = h('div', { className: 'big-subtitle' });

  if (state.stats) {
    subEl.appendChild(h('strong', {}, (state.stats.total_reclassifications || 0).toLocaleString()));
    subEl.appendChild(document.createTextNode(' reclassifications across '));
    subEl.appendChild(h('strong', {}, (state.stats.total_genes || 0).toLocaleString()));
    subEl.appendChild(document.createTextNode(' genes'));
  }

  statBox.appendChild(numEl);
  statBox.appendChild(subEl);
  container.appendChild(statBox);

  if (state.stats) {
    requestAnimationFrame(() => animateNumber(numEl, state.stats.total_variants || 0));
  }

  // Time range buttons
  const timeRow = h('div', { className: 'time-range' });
  for (const r of ['1m', '1y', '5y', 'All']) {
    const key = r.toLowerCase();
    const btn = h('button', {
      className: `time-btn${state.timeRange === key ? ' active' : ''}`,
      onClick: () => { state.timeRange = key; state.geneListPage = 0; reloadOverview(); },
    }, r);
    timeRow.appendChild(btn);
  }
  container.appendChild(timeRow);

  // Submissions timeline chart placeholder
  const chartEl = h('div', { className: 'submissions-chart', id: 'submissions-chart' });
  container.appendChild(chartEl);

  // Gene list (or Top Phenotypes if in phenotype mode)
  if (state.searchMode === 'phenotype' && !state.phenotypeGenes) {
    // Show top conditions from ClinVar submissions (precomputed)
    const phenoBox = h('div', { className: 'gene-list' });
    phenoBox.appendChild(h('div', { className: 'gene-list-title' }, 'Top Phenotypes in ClinVar'));
    if (state.topConditions && state.topConditions.length > 0) {
      const maxC = state.topConditions[0]?.submission_count || 1;
      const page = state.conditionListPage || 0;
      const slice = state.topConditions.slice(page * 5, page * 5 + 5);
      for (const c of slice) {
        const pct = Math.max(4, (c.submission_count / maxC) * 100);
        const row = h('div', { className: 'gene-row', onClick: () => { state.searchMode = 'phenotype'; handlePhenotypeSearchDirect(c.condition); } }, [
          h('span', { className: 'gene-name', style: { fontSize: '11px' } }, c.condition),
          h('span', { className: 'gene-vus-count' }, (c.submission_count || 0).toLocaleString()),
        ]);
        phenoBox.appendChild(row);
        phenoBox.appendChild(h('div', { className: 'gene-bar-wrap' }, [h('div', { className: 'gene-bar', style: { width: pct + '%' } })]));
      }
      // Pagination
      const totalPages = Math.ceil(state.topConditions.length / 5);
      if (totalPages > 1) {
        const pager = h('div', { className: 'variant-pager', style: { marginTop: '6px' } });
        pager.appendChild(h('button', { className: 'page-btn', disabled: page <= 0, onClick: () => { state.conditionListPage = page - 1; render(); renderSubmissionsChart(); } }, '\u2190'));
        pager.appendChild(h('span', { style: { fontSize: '10px', color: 'var(--text-secondary)' } }, `${page + 1}/${totalPages}`));
        pager.appendChild(h('button', { className: 'page-btn', disabled: page >= totalPages - 1, onClick: () => { state.conditionListPage = page + 1; render(); renderSubmissionsChart(); } }, '\u2192'));
        phenoBox.appendChild(pager);
      }
    } else {
      phenoBox.appendChild(h('div', { className: 'computing-placeholder' }, [
        h('div', { className: 'computing-bar' }, [h('div', { className: 'computing-fill' })]),
        h('div', { className: 'computing-text' }, 'Loading top phenotypes...'),
      ]));
    }
    container.appendChild(phenoBox);
  } else if (state.genes.length > 0 && state.searchMode === 'gene') {
    const list = h('div', { className: 'gene-list' });
    list.appendChild(h('div', { className: 'gene-list-title' }, 'Top Genes by Submissions'));
    const maxVal = state.genes[0]?.total_variants || 1;
    const pageSize = 5;
    const start = state.geneListPage * pageSize;
    const pageGenes = state.genes.slice(start, start + pageSize);
    const totalPages = Math.ceil(state.genes.length / pageSize);
    pageGenes.forEach((g, i) => {
      const pct = Math.max(4, ((g.total_variants || 0) / maxVal) * 100);
      const row = h('div', { className: 'gene-row', onClick: () => selectGene(g.symbol) }, [
        h('span', { className: 'gene-rank' }, `${start + i + 1}`),
        h('span', { className: 'gene-name' }, g.symbol),
        h('div', { className: 'gene-bar-wrap' }, [
          h('div', { className: 'gene-bar', style: { width: `${pct}%` } }),
        ]),
        h('span', { className: 'gene-vus-count' }, (g.total_variants || 0).toLocaleString()),
      ]);
      list.appendChild(row);
    });
    // Pagination controls
    if (totalPages > 1) {
      const pager = h('div', { className: 'variant-pager' });
      pager.appendChild(h('button', {
        className: 'page-btn', disabled: state.geneListPage <= 0,
        onClick: () => { state.geneListPage--; render(); renderSubmissionsChart(); },
      }, '\u2190 Prev'));
      pager.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)', alignSelf: 'center' } },
        `${state.geneListPage + 1}/${totalPages}`));
      pager.appendChild(h('button', {
        className: 'page-btn', disabled: state.geneListPage >= totalPages - 1,
        onClick: () => { state.geneListPage++; render(); renderSubmissionsChart(); },
      }, 'Next \u2192'));
      list.appendChild(pager);
    }
    container.appendChild(list);
  } else if (state.searchMode === 'gene') {
    container.appendChild(h('div', { className: 'loading-spinner' }, [h('div', { className: 'spinner' })]));
  }

  return container;
}

// ── Reload Overview with time filter ──────────────────────────────────────
async function reloadOverview() {
  const df = dateFrom(state.timeRange);
  const params = {};
  if (df) params.date_from = df;
  const period = state.timeRange === 'all' ? 'all' : state.timeRange;

  try {
    const [statsRes, genesRes, tlRes, condRes] = await Promise.allSettled([
      api('/stats', params),
      api('/genes', { ...params, per_page: 100, sort: 'total_variants', order: 'desc' }),
      api('/submissions-timeline', params),
      api('/phenotype/top', { period }),
    ]);
    if (statsRes.status === 'fulfilled') state.stats = statsRes.value.data;
    if (genesRes.status === 'fulfilled') state.genes = (genesRes.value.data || []).sort((a, b) => (b.total_variants || 0) - (a.total_variants || 0));
    state.submissionsTimeline = tlRes.status === 'fulfilled' ? tlRes.value.data?.buckets : null;
    if (condRes.status === 'fulfilled') { state.topConditions = condRes.value.data || []; state.conditionListPage = 0; }
  } catch (e) { console.error(e); }
  render();
  renderSubmissionsChart();
}

function renderSubmissionsChart() {
  const el = document.getElementById('submissions-chart');
  if (!el) return;
  const buckets = state.submissionsTimeline;
  if (!buckets?.length) { el.innerHTML = '<div style="text-align:center;color:#9CA3AF;font-size:11px;padding:8px">No submission data for this range</div>'; return; }

  // Same stacked-area style as gene timeline
  const n = buckets.length, w = 380, h = 120;
  const pad = { l: 36, r: 6, t: 8, b: 22 }, pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  // Build cumulative sums (starts at 0, grows over time)
  let cumP = 0, cumV = 0, cumB = 0;
  const cats = buckets.map(b => {
    cumP += parseInt(b.path || 0) + parseInt(b.likely_pathogenic || 0);
    cumV += parseInt(b.vus || 0);
    cumB += parseInt(b.ben || 0);
    return { month: b.period || b.month || b.day || '', p: cumP, v: cumV, b: cumB, total: cumP + cumV + cumB };
  });
  const maxY = Math.max(1, cats[cats.length - 1]?.total || 1);
  const xAt = i => pad.l + (i / Math.max(1, n - 1)) * pw;
  const yAt = v => pad.t + ph - (v / maxY) * ph;

  // Stacked area paths (same as gene timeline)
  const makePath = (upper, lower) => {
    let d = 'M' + upper.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' L');
    d += ' L' + [...lower].reverse().map((v, i) => `${xAt(n - 1 - i)},${yAt(v)}`).join(' L') + ' Z';
    return d;
  };

  const benPath = makePath(cats.map(c => c.b), cats.map(() => 0));
  const vusPath = makePath(cats.map(c => c.b + c.v), cats.map(c => c.b));
  const pathPath = makePath(cats.map(c => c.total), cats.map(c => c.b + c.v));

  // Y labels
  const fmtY = v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v;
  const yLabels = [0, Math.round(maxY/2), maxY].map(v =>
    `<text x="${pad.l-4}" y="${yAt(v)+3}" text-anchor="end" fill="#9CA3AF" font-size="8">${fmtY(v)}</text>`
  ).join('');

  // X labels
  const step = Math.max(1, Math.floor(n / 5));
  const xLabels = cats.filter((_, i) => i % step === 0 || i === n - 1).map(c =>
    `<text x="${xAt(cats.indexOf(c))}" y="${h-4}" text-anchor="middle" fill="#9CA3AF" font-size="8">${(c.month||'').slice(2,7)}</text>`
  ).join('');

  // Grid lines
  const grid = [0.25, 0.5, 0.75].map(f =>
    `<line x1="${pad.l}" y1="${yAt(maxY*f)}" x2="${w-pad.r}" y2="${yAt(maxY*f)}" stroke="#F3F4F6" stroke-width="0.5"/>`
  ).join('');

  el.innerHTML = `<div style="font-size:11px;color:#6B7280;font-weight:600;margin-bottom:4px">ClinVar Submissions over Time</div>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px" preserveAspectRatio="none">
      ${grid}
      <path d="${benPath}" fill="#3B82F6" opacity="0.5"/>
      <path d="${vusPath}" fill="#EAB308" opacity="0.5"/>
      <path d="${pathPath}" fill="#EF4444" opacity="0.5"/>
      ${yLabels}${xLabels}
    </svg>
    <div style="display:flex;gap:12px;justify-content:center;font-size:9px;color:#6B7280;margin-top:2px">
      <span><span style="color:#EF4444">●</span> LP/P</span>
      <span><span style="color:#EAB308">●</span> VUS</span>
      <span><span style="color:#3B82F6">●</span> B/LB</span>
    </div>`;
}

// ── Gene Selection ─────────────────────────────────────────────────────────
async function selectGene(symbol) {
  state.mode = 'gene';
  state.selectedGene = symbol;
  state.geneData = {};
  state.variants = [];
  state.variantPage = 1;
  state.expandedVariants.clear();
  state.activeFilters = new Set(['pathogenic', 'likely_pathogenic', 'uncertain_significance', 'likely_benign', 'benign']);
  state.hgvsFilter = '';
  state.codingFilter = 'all';
  state.positionFrom = '';
  state.positionTo = '';

  // INSTANT: show gene name + computing placeholders
  render();

  const df = dateFrom(state.timeRange);
  const variantParams = { per_page: 5 };
  if (df) variantParams.date_from = df;
  const classFilter = [...state.activeFilters].join(',');
  if (classFilter) variantParams.classification = classFilter;

  // Phase 1: Gene header + variants (fast, ~300ms)
  try {
    const [geneRes, varRes] = await Promise.all([
      api(`/genes/${symbol}`),
      api(`/genes/${symbol}/variants`, variantParams),
    ]);
    if (geneRes) state.geneData.gene = geneRes.data;
    if (varRes) { state.variants = varRes.data || []; state.variantsMeta = { total: varRes.total, per_page: varRes.per_page, current_page: varRes.current_page, last_page: varRes.last_page }; }
    render(); // Update immediately with gene header + variants
  } catch(e) { console.error('Gene load:', e); }

  // Phase 2: Heavy computations in background (user sees data already)
  Promise.allSettled([
    api(`/genes/${symbol}/timeline`),
    api(`/genes/${symbol}/drift`),
    api(`/genes/${symbol}/genome-browser`),
    api(`/genes/${symbol}/concordance`),
    api(`/genes/${symbol}/survival`),
  ]).then(([timelineRes, driftRes, browserRes, concRes, survRes]) => {
    if (timelineRes.status === 'fulfilled') state.geneData.timeline = timelineRes.value.data;
    if (driftRes.status === 'fulfilled') state.geneData.drift = driftRes.value.data;
    if (browserRes.status === 'fulfilled') state.geneData.browser = browserRes.value.data;
    if (concRes.status === 'fulfilled') state.geneData.concordance = concRes.value.data;
    if (survRes.status === 'fulfilled') state.geneData.survival = survRes.value.data;
    render(); // Final update with all sections
  });
}

// ── Reload variants (filter/time change) ───────────────────────────────────
async function reloadVariants() {
  if (!state.selectedGene) return;
  const df = dateFrom(state.timeRange);
  const params = { per_page: 5 };
  if (df) params.date_from = df;
  const classFilter = [...state.activeFilters].join(',');
  if (classFilter) params.classification = classFilter;
  if (state.variantPage > 1) params.page = state.variantPage;
  if (state.hgvsFilter) params.hgvs_search = state.hgvsFilter;
  if (state.positionFrom) params.pos_from = state.positionFrom;
  if (state.positionTo) params.pos_to = state.positionTo;

  try {
    const res = await api(`/genes/${state.selectedGene}/variants`, params);
    let filtered = res.data || [];
    // Client-side coding/noncoding filter
    if (state.codingFilter === 'coding') {
      filtered = filtered.filter(v => v.hgvs && /c\./.test(v.hgvs));
    } else if (state.codingFilter === 'noncoding') {
      filtered = filtered.filter(v => !v.hgvs || !/c\./.test(v.hgvs));
    }
    // Client-side text search — matches hgvs, condition, position, any field
    if (state.hgvsFilter) {
      const q = state.hgvsFilter.toLowerCase();
      filtered = filtered.filter(v => {
        const searchable = [v.hgvs, v.condition, v.review_status, v.chromosome ? `chr${v.chromosome}:${v.position}` : '', String(v.position || '')].join(' ').toLowerCase();
        return searchable.includes(q);
      });
    }
    // Client-side position range fallback
    if (state.positionFrom) {
      const from = parseInt(state.positionFrom);
      if (!isNaN(from)) filtered = filtered.filter(v => v.position >= from);
    }
    if (state.positionTo) {
      const to = parseInt(state.positionTo);
      if (!isNaN(to)) filtered = filtered.filter(v => v.position <= to);
    }
    state.variants = filtered;
    state.variantsMeta = { total: res.total, per_page: res.per_page, current_page: res.current_page, last_page: res.last_page };
  } catch (e) {
    console.error('Reload variants error:', e);
  }
  render();
}

// ── Gene Detail Mode ───────────────────────────────────────────────────────
function renderGeneDetail() {
  const container = h('div', { className: 'gene-detail' });

  // Back button
  container.appendChild(h('button', {
    className: 'back-btn',
    onClick: () => { state.mode = 'overview'; state.selectedGene = null; render(); },
    innerHTML: '&larr; Back',
  }));

  const scroll = h('div', { className: 'detail-scroll' });

  const gene = state.geneData.gene;
  if (!gene) {
    // Show gene name immediately with computing animation
    scroll.appendChild(h('div', { className: 'gene-header-loading' }, [
      h('div', { className: 'gene-name-big' }, state.selectedGene || '...'),
      h('div', { className: 'computing-bar' }, [
        h('div', { className: 'computing-fill' }),
      ]),
      h('div', { className: 'computing-text' }, 'Querying ClinVar database...'),
    ]));
    container.appendChild(scroll);
    return container;
  }

  // Gene header
  scroll.appendChild(renderGeneHeader(gene));

  // Filter chips
  // Time range
  const timeRow = h('div', { className: 'time-range' });
  for (const r of ['1m', '1y', '5y', 'All']) {
    const key = r.toLowerCase();
    const btn = h('button', {
      className: `time-btn${state.timeRange === key ? ' active' : ''}`,
      onClick: () => { state.timeRange = key; state.variantPage = 1; reloadVariants(); },
    }, r);
    timeRow.appendChild(btn);
  }
  scroll.appendChild(timeRow);

  // Sections — accordion behavior: only one open at a time
  // "Overview" section with donut/bar/conditions — open by default
  const gd = state.geneData;
  scroll.appendChild(makeSection('Overview', () => renderGeneOverviewSection(gene), false));
  scroll.appendChild(makeSection(`Variants (${state.variantsMeta?.total?.toLocaleString() || '...'})`, renderVariantList, true));
  scroll.appendChild(makeSection('Genome Browser', gd.browser ? renderGenomeBrowser : () => computingPlaceholder('Querying genomic coordinates...'), true));
  scroll.appendChild(makeSection('Classification Drift', gd.drift ? renderDriftChart : () => computingPlaceholder('Computing classification drift...'), true));
  scroll.appendChild(makeSection('Timeline', gd.timeline ? renderTimelineChart : () => computingPlaceholder('Aggregating submission timeline...'), true));
  if (gd.concordance?.matrix?.length) scroll.appendChild(makeSection('Concordance', renderConcordance, true));
  if (gd.survival?.points?.length > 1) scroll.appendChild(makeSection('VUS Survival', renderSurvivalChart, true));

  container.appendChild(scroll);
  return container;
}

function renderGeneHeader(gene) {
  const hdr = h('div', { className: 'gene-header' });
  hdr.appendChild(h('div', { className: 'gene-title' }, gene.symbol || state.selectedGene));
  const meta = h('div', { className: 'gene-meta' });
  if (gene.omim_id) meta.appendChild(h('a', { className: 'meta-link', href: `https://omim.org/entry/${gene.omim_id}`, target: '_blank' }, `OMIM:${gene.omim_id}`));
  if (gene.medgen_id) meta.appendChild(h('a', { className: 'meta-link', href: `https://www.ncbi.nlm.nih.gov/medgen/${gene.medgen_id}`, target: '_blank' }, `MedGen:${gene.medgen_id}`));
  if (gene.total_variants) meta.appendChild(h('span', { className: 'meta-link', style: { color: 'var(--text-secondary)' } }, `${gene.total_variants.toLocaleString()} variants`));
  hdr.appendChild(meta);
  return hdr;
}

function renderGeneOverviewSection(gene) {
  const wrap = h('div');
  // Use timeline data for time-filtered counts if available, otherwise gene totals
  let cc = gene.classification_counts || {};
  const df = dateFrom(state.timeRange);
  if (df && state.geneData.timeline?.buckets?.length) {
    const filtered = { pathogenic: 0, likely_pathogenic: 0, uncertain_significance: 0, likely_benign: 0, benign: 0 };
    for (const b of state.geneData.timeline.buckets) {
      if (b.month >= df.slice(0, 7)) {
        filtered.pathogenic += parseInt(b.pathogenic || 0);
        filtered.likely_pathogenic += parseInt(b.likely_pathogenic || 0);
        filtered.uncertain_significance += parseInt(b.vus || 0);
        filtered.likely_benign += parseInt(b.likely_benign || 0);
        filtered.benign += parseInt(b.benign || 0);
      }
    }
    const fTotal = Object.values(filtered).reduce((s, v) => s + v, 0);
    if (fTotal > 0) cc = filtered;
  }
  const counts = h('div', { className: 'class-counts' });
  for (const [key, label] of Object.entries(CLASS_SHORT)) {
    const val = cc[key] || 0;
    if (val > 0) counts.appendChild(h('span', { className: `class-badge ${CLASS_CSS[key]}` }, `${label} ${val}`));
  }
  wrap.appendChild(counts);

  const total = Object.values(cc).reduce((s, v) => s + (v || 0), 0);
  if (total > 0) {
    const donutRow = h('div', { className: 'donut-row' });
    donutRow.appendChild(renderDonut(cc, total));
    const distBar = h('div', { className: 'class-dist-bar' });
    for (const key of Object.keys(CLASS_COLORS)) {
      const pct = ((cc[key] || 0) / total) * 100;
      if (pct > 0) distBar.appendChild(h('div', { style: { width: `${pct}%`, background: CLASS_COLORS[key] } }));
    }
    const distWrap = h('div', { style: { flex: '1' } });
    distWrap.appendChild(distBar);
    const legend = h('div', { className: 'donut-legend' });
    for (const [key, color] of Object.entries(CLASS_COLORS)) {
      if ((cc[key] || 0) > 0) legend.appendChild(h('span', {}, [h('span', { className: 'legend-dot', style: { background: color } }), `${CLASS_SHORT[key]} ${((cc[key] / total) * 100).toFixed(0)}%`]));
    }
    distWrap.appendChild(legend);
    donutRow.appendChild(distWrap);
    wrap.appendChild(donutRow);
  }

  if (gene.conditions?.length) {
    const tags = h('div', { className: 'condition-tags' });
    for (const c of gene.conditions.slice(0, 6)) {
      const name = typeof c === 'string' ? c : (c.name || c.condition_name || JSON.stringify(c));
      tags.appendChild(h('span', { className: 'condition-tag', title: `Search: ${name}`, style: { cursor: 'pointer' },
        onClick: (e) => { e.stopPropagation(); state.mode='overview'; state.selectedGene=null; state.searchMode='phenotype'; state.phenotypeGenes=null; state.selectedHpoTerms=[]; handlePhenotypeSearchDirect(name); },
      }, name));
    }
    wrap.appendChild(tags);
  }
  return wrap;
}

function renderDonut(cc, total) {
  const size = 60;
  const cx = size / 2, cy = size / 2, r = 22, strokeW = 8;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  let paths = '';

  for (const [key, color] of Object.entries(CLASS_COLORS)) {
    const val = cc[key] || 0;
    if (val === 0) continue;
    const pct = val / total;
    const dashLen = circumference * pct;
    paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-dasharray="${dashLen} ${circumference - dashLen}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dashLen;
  }

  const svg = h('svg', {
    className: 'donut-svg', width: size, height: size, viewBox: `0 0 ${size} ${size}`,
    innerHTML: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E7EB" stroke-width="${strokeW}"/>${paths}<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="#111827">${total}</text>`,
  });
  return svg;
}

// ── Filter Chips ───────────────────────────────────────────────────────────
function renderFilterChips() {
  const wrap = h('div', { className: 'filter-section' });

  // Classification chips row
  const row = h('div', { className: 'filter-chips' });
  for (const [key, label] of Object.entries(CLASS_SHORT)) {
    const active = state.activeFilters.has(key);
    const chip = h('div', {
      className: `filter-chip ${CLASS_CSS[key]}${active ? '' : ' inactive'}`,
      onClick: () => {
        if (active) state.activeFilters.delete(key);
        else state.activeFilters.add(key);
        state.variantPage = 1;
        reloadVariants();
        renderGenomeBrowserCanvas();
      },
    }, label);
    row.appendChild(chip);
  }
  wrap.appendChild(row);

  // Nomenclature filter dropdown
  const nomRow = h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' } });
  nomRow.appendChild(h('span', { style: { fontSize: '10px', color: 'var(--text-secondary)' } }, 'Show:'));
  const nomSelect = h('select', {
    style: { fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: '1px solid #E5E7EB', background: '#fff', color: '#111' },
    value: state.hgvsFilter || 'all',
    onChange: (e) => {
      state.hgvsFilter = e.target.value === 'all' ? '' : e.target.value;
      state.variantPage = 1;
      reloadVariants();
    },
  });
  for (const [val, label] of [['all', 'All variants'], ['c.', 'DNA (c. notation)'], ['p.', 'Protein (p. notation)'], ['del', 'Deletions'], ['dup', 'Duplications'], ['ins', 'Insertions']]) {
    const opt = h('option', { value: val }, label);
    if ((state.hgvsFilter || 'all') === val) opt.selected = true;
    nomSelect.appendChild(opt);
  }
  nomRow.appendChild(nomSelect);
  wrap.appendChild(nomRow);

  // Position range inputs
  const posRow = h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px', alignItems: 'center' } });
  posRow.appendChild(h('span', { style: { fontSize: '10px', color: 'var(--text-secondary, #6B7280)', whiteSpace: 'nowrap' } }, 'Pos:'));
  const posFromInput = h('input', {
    type: 'text', placeholder: 'from',
    value: state.positionFrom,
    style: { width: '70px', fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: '1px solid #E5E7EB', background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #111)' },
    onInput: (e) => {
      state.positionFrom = e.target.value;
      state.variantPage = 1;
      clearTimeout(state._posTimeout);
      state._posTimeout = setTimeout(() => reloadVariants(), 600);
    },
  });
  const posToInput = h('input', {
    type: 'text', placeholder: 'to',
    value: state.positionTo,
    style: { width: '70px', fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: '1px solid #E5E7EB', background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #111)' },
    onInput: (e) => {
      state.positionTo = e.target.value;
      state.variantPage = 1;
      clearTimeout(state._posTimeout);
      state._posTimeout = setTimeout(() => reloadVariants(), 600);
    },
  });
  posRow.appendChild(posFromInput);
  posRow.appendChild(h('span', { style: { fontSize: '10px', color: 'var(--text-secondary, #6B7280)' } }, '\u2013'));
  posRow.appendChild(posToInput);
  if (state.positionFrom || state.positionTo) {
    posRow.appendChild(h('span', {
      style: { cursor: 'pointer', fontSize: '14px', color: '#9CA3AF' },
      onClick: () => { state.positionFrom = ''; state.positionTo = ''; state.variantPage = 1; reloadVariants(); },
    }, '\u00D7'));
  }
  wrap.appendChild(posRow);

  return wrap;
}

function computingPlaceholder(msg) {
  return h('div', { className: 'computing-placeholder' }, [
    h('div', { className: 'computing-bar' }, [h('div', { className: 'computing-fill' })]),
    h('div', { className: 'computing-text' }, msg || 'Computing...'),
  ]);
}

// ── Collapsible Section ────────────────────────────────────────────────────
function makeSection(title, contentOrFn, collapsed = false) {
  // If this section was open before re-render, keep it open
  const shouldBeOpen = state.openSection === title || (!collapsed && !state.openSection);
  const section = h('div', { className: `section${shouldBeOpen ? '' : ' collapsed'}`, 'data-accordion': 'true', 'data-section-title': title });
  const header = h('div', { className: 'section-header' }, [
    h('span', { className: 'section-title' }, title),
    h('span', { className: 'section-toggle' }, '\u25BC'),
  ]);
  const body = h('div', { className: 'section-body' });
  let rendered = false;

  header.addEventListener('click', () => {
    const wasCollapsed = section.classList.contains('collapsed');
    // Accordion: collapse all siblings first
    const parent = section.parentElement;
    if (parent) {
      parent.querySelectorAll('[data-accordion="true"]').forEach(s => {
        if (s !== section) s.classList.add('collapsed');
      });
    }
    section.classList.toggle('collapsed');
    // Remember which section is open
    state.openSection = wasCollapsed ? title : null;
    // Lazy render: only build content on first expand
    if (wasCollapsed && !rendered && typeof contentOrFn === 'function') {
      rendered = true;
      body.appendChild(contentOrFn());
    }
  });

  // Render content if open
  if (typeof contentOrFn !== 'function') {
    body.appendChild(contentOrFn);
    rendered = true;
  } else if (shouldBeOpen) {
    body.appendChild(contentOrFn());
    rendered = true;
  }

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// ── Variant List ───────────────────────────────────────────────────────────
function renderVariantList() {
  const wrap = h('div');
  // Filters inside the Variants section
  wrap.appendChild(renderFilterChips());
  if (state.variants.length === 0) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No variants found for current filters'));
    return wrap;
  }

  for (const v of state.variants) {
    const card = h('div', { className: `variant-card${state.expandedVariants.has(v.hgvs) ? ' open' : ''}` });
    const classLabel = (v.classification || '').replace(/_/g, ' ');
    const classKey = v.classification || 'uncertain_significance';

    const top = h('div', { className: 'variant-top', onClick: () => {
      if (state.expandedVariants.has(v.hgvs)) state.expandedVariants.delete(v.hgvs);
      else state.expandedVariants.add(v.hgvs);
      card.classList.toggle('open');
    }}, [
      h('span', { className: 'variant-hgvs' }, v.hgvs || 'Unknown'),
      h('span', { className: `variant-class-tag ${classKey}` }, CLASS_SHORT[classKey] || classLabel),
    ]);
    card.appendChild(top);

    // Expanded details
    const details = h('div', { className: 'variant-expanded' });
    if (v.chromosome && v.position) {
      details.appendChild(h('div', { className: 'variant-detail-row' }, [
        h('span', { className: 'variant-detail-label' }, 'Position:'),
        h('span', {}, `chr${v.chromosome}:${v.position}`),
      ]));
    }
    if (v.review_status) {
      details.appendChild(h('div', { className: 'variant-detail-row' }, [
        h('span', { className: 'variant-detail-label' }, 'Review:'),
        h('span', {}, v.review_status),
      ]));
    }
    if (v.last_evaluated) {
      details.appendChild(h('div', { className: 'variant-detail-row' }, [
        h('span', { className: 'variant-detail-label' }, 'Last evaluated:'),
        h('span', {}, v.last_evaluated),
      ]));
    }
    if (v.phenotype_ids) {
      const pids = typeof v.phenotype_ids === 'string' ? JSON.parse(v.phenotype_ids) : v.phenotype_ids;
      const links = [];
      if (pids?.omim) pids.omim.forEach(id => links.push(h('a', { href: `https://omim.org/entry/${id}`, target: '_blank', className: 'pheno-link' }, `OMIM:${id}`)));
      if (pids?.medgen) pids.medgen.forEach(id => links.push(h('a', { href: `https://www.ncbi.nlm.nih.gov/medgen/${id}`, target: '_blank', className: 'pheno-link' }, `MedGen:${id}`)));
      if (pids?.orphanet) pids.orphanet.forEach(id => links.push(h('a', { href: `https://www.orpha.net/en/disease/detail/${id}`, target: '_blank', className: 'pheno-link' }, `ORPHA:${id}`)));
      if (pids?.hpo) pids.hpo.forEach(id => links.push(h('a', { href: `https://hpo.jax.org/browse/term/${id}`, target: '_blank', className: 'pheno-link' }, id)));
      if (links.length) {
        const row = h('div', { className: 'variant-detail-row' });
        row.appendChild(h('span', { className: 'variant-detail-label' }, 'Phenotype:'));
        const innerWrap = h('span', { className: 'pheno-links' });
        links.forEach(l => innerWrap.appendChild(l));
        row.appendChild(innerWrap);
        details.appendChild(row);
      }
    }
    // ClinVar link + Alert button
    const actionRow = h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center' } });
    if (v.clinvar_id || v.variation_id) {
      const cvId = v.clinvar_id || v.variation_id;
      actionRow.appendChild(h('a', { href: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${cvId}/`, target: '_blank', style: { fontSize: '11px' } }, 'ClinVar \u2192'));
    }
    // Alert subscribe button
    const alertBtn = h('button', {
      className: 'alert-btn',
      onClick: (e) => {
        e.stopPropagation();
        const existing = card.querySelector('.alert-form');
        if (existing) { existing.remove(); return; }
        const form = h('div', { className: 'alert-form' }, [
          h('div', { style: { fontSize: '10px', fontWeight: '600', marginBottom: '4px' } }, '\uD83D\uDD14 Get notified on reclassification'),
          h('input', {
            type: 'email', placeholder: 'your@email.com', className: 'alert-email-input',
            onKeydown: (ev) => { if (ev.key === 'Enter') submitAlert(ev.target.value, v, form); },
          }),
          h('button', {
            className: 'alert-submit-btn',
            onClick: () => { const input = form.querySelector('input'); submitAlert(input.value, v, form); },
          }, 'Subscribe'),
        ]);
        card.appendChild(form);
      },
    }, '\uD83D\uDD14 Alert');
    actionRow.appendChild(alertBtn);
    details.appendChild(actionRow);
    card.appendChild(details);
    wrap.appendChild(card);
  }

  // Server-side pagination (per_page=5)
  const meta = state.variantsMeta || {};
  const totalPages = meta.last_page || Math.ceil((meta.total || state.variants.length) / 5);
  const pager = h('div', { className: 'variant-pager' });
  pager.appendChild(h('button', {
    className: 'page-btn', disabled: state.variantPage <= 1,
    onClick: () => { state.variantPage--; reloadVariants(); },
  }, '\u2190 Prev'));
  pager.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)', alignSelf: 'center' } },
    `${state.variantPage}/${totalPages || 1}${meta.total ? ` (${meta.total} total)` : ''}`));
  pager.appendChild(h('button', {
    className: 'page-btn', disabled: state.variantPage >= totalPages,
    onClick: () => { state.variantPage++; reloadVariants(); },
  }, 'Next \u2192'));
  pager.appendChild(h('button', {
    className: 'page-btn export-all-btn', title: 'Export all variants (CSV)',
    onClick: () => exportAllVariants(),
  }, 'Export All'));
  wrap.appendChild(pager);

  return wrap;
}

async function submitAlert(email, variant, formEl) {
  if (!email || !email.includes('@')) { formEl.querySelector('input').style.borderColor = '#EF4444'; return; }
  try {
    const body = {
      email,
      gene_symbol: state.selectedGene,
      variation_id: variant.variation_id || variant.clinvar_id || null,
      hgvs: variant.hgvs || null,
      alert_on_reclassification: true,
      alert_on_new_submission: true,
    };
    const res = await fetch(`${API_BASE}/watchlist/subscribe?api_key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      formEl.innerHTML = '<div style="font-size:10px;color:#16A34A;padding:4px 0">\u2705 Check your email to confirm the alert for ' + (variant.hgvs || state.selectedGene) + '</div>';
    } else {
      formEl.innerHTML = '<div style="font-size:10px;color:#EF4444;padding:4px 0">\u274C ' + (data.message || data.error || 'Error') + '</div>';
    }
  } catch (e) {
    formEl.innerHTML = '<div style="font-size:10px;color:#EF4444;padding:4px 0">\u274C Network error</div>';
  }
}

async function exportAllVariants() {
  if (!state.selectedGene) return;
  try {
    const df = dateFrom(state.timeRange);
    const params = { per_page: 10000 };
    if (df) params.date_from = df;
    const classFilter = [...state.activeFilters].join(',');
    if (classFilter) params.classification = classFilter;
    const res = await api(`/genes/${state.selectedGene}/variants`, params);
    const allVars = res.data || [];
    if (allVars.length === 0) return;

    const sep = ',';
    const headers = ['hgvs', 'classification', 'chromosome', 'position', 'review_status', 'last_evaluated', 'clinvar_id'];
    const rows = [headers.join(sep)];
    for (const v of allVars) {
      const row = headers.map(hdr => {
        let val = v[hdr] || '';
        if (typeof val === 'string' && (val.includes(sep) || val.includes('"') || val.includes('\n'))) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      rows.push(row.join(sep));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.selectedGene}_all_variants.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Export all error:', e);
  }
}

// ── Genome Browser ─────────────────────────────────────────────────────────
let genomeBrowserCanvasEl = null;
let genomeBrowserTooltipEl = null;

function renderGenomeBrowser() {
  const wrap = h('div', { className: 'genome-browser' });
  const canvas = h('canvas', { className: 'genome-canvas' });
  const tooltip = h('div', { className: 'genome-tooltip' });
  const controls = h('div', { className: 'genome-controls' }, [
    h('button', { className: 'genome-btn', onClick: () => { state.genomeBrowser.zoom = Math.min(state.genomeBrowser.zoom * 1.5, 20); renderGenomeBrowserCanvas(); } }, 'Zoom +'),
    h('button', { className: 'genome-btn', onClick: () => { state.genomeBrowser.zoom = Math.max(state.genomeBrowser.zoom / 1.5, 0.01); state.genomeBrowser.panX = 0; renderGenomeBrowserCanvas(); } }, 'Zoom \u2212'),
    h('button', { className: 'genome-btn', onClick: () => { state.genomeBrowser.zoom = 1; state.genomeBrowser.panX = 0; renderGenomeBrowserCanvas(); } }, 'Reset'),
  ]);

  wrap.appendChild(canvas);
  wrap.appendChild(tooltip);
  wrap.appendChild(controls);

  genomeBrowserCanvasEl = canvas;
  genomeBrowserTooltipEl = tooltip;

  // Mouse events for pan and hover
  canvas.addEventListener('mousedown', (e) => {
    state.genomeBrowser.dragging = true;
    state.genomeBrowser.lastX = e.clientX;
  });
  canvas.addEventListener('mousemove', (e) => {
    if (state.genomeBrowser.dragging) {
      const dx = e.clientX - state.genomeBrowser.lastX;
      state.genomeBrowser.panX += dx;
      state.genomeBrowser.lastX = e.clientX;
      renderGenomeBrowserCanvas();
    } else {
      handleBrowserHover(e, canvas, tooltip);
    }
  });
  canvas.addEventListener('mouseup', () => { state.genomeBrowser.dragging = false; });
  canvas.addEventListener('mouseleave', () => { state.genomeBrowser.dragging = false; tooltip.style.display = 'none'; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY < 0) state.genomeBrowser.zoom = Math.min(state.genomeBrowser.zoom * 1.2, 20);
    else { state.genomeBrowser.zoom = Math.max(state.genomeBrowser.zoom / 1.2, 0.01); }
    renderGenomeBrowserCanvas();
  }, { passive: false });

  // Double rAF: first frame lets browser compute layout after display:none→block,
  // second frame reads correct getBoundingClientRect dimensions
  requestAnimationFrame(() => requestAnimationFrame(() => renderGenomeBrowserCanvas()));
  return wrap;
}

function getFilteredBrowserVariants() {
  const data = state.geneData.browser;
  if (!data || !data.variants) return [];
  return data.variants.filter(v => state.activeFilters.has(v.classification));
}

function renderGenomeBrowserCanvas() {
  const canvas = genomeBrowserCanvasEl;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 120 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '120px';
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 120;

  ctx.clearRect(0, 0, W, H);

  const variants = getFilteredBrowserVariants();
  if (variants.length === 0) {
    ctx.fillStyle = '#6B7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No variants to display', W / 2, H / 2);
    return;
  }

  const positions = variants.map(v => v.position).filter(p => p != null);
  if (positions.length === 0) return;

  const minPos = Math.min(...positions);
  const maxPos = Math.max(...positions);
  const range = Math.max(maxPos - minPos, 1);
  const zoom = state.genomeBrowser.zoom;
  const panX = state.genomeBrowser.panX;

  const padding = 20;
  const plotW = (W - padding * 2) * zoom;
  const geneY = H - 30;

  // Calculate visible genomic range based on zoom/pan
  const viewStart = minPos - (padding - panX) / plotW * range;
  const viewEnd = minPos + (W - padding - panX) / plotW * range;

  // Gene boundary markers (dashed vertical lines at gene start/end)
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#8B5CF6';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  // Gene start boundary
  const geneStartX = padding + ((minPos - minPos) / range) * plotW + panX;
  ctx.beginPath();
  ctx.moveTo(geneStartX, 18);
  ctx.lineTo(geneStartX, geneY + 6);
  ctx.stroke();
  // Gene end boundary
  const geneEndX = padding + ((maxPos - minPos) / range) * plotW + panX;
  ctx.beginPath();
  ctx.moveTo(geneEndX, 18);
  ctx.lineTo(geneEndX, geneY + 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  // Gene body bar
  ctx.fillStyle = '#E5E7EB';
  const geneBarStart = padding + panX;
  ctx.fillRect(geneBarStart, geneY, plotW, 6);
  ctx.fillStyle = '#8B5CF6';
  ctx.fillRect(geneBarStart, geneY, plotW, 6);
  ctx.globalAlpha = 0.3;
  ctx.fillRect(geneBarStart, geneY, plotW, 6);
  ctx.globalAlpha = 1;

  // Gene name label centered on gene body
  ctx.fillStyle = '#6B7280';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  const geneName = state.geneData.browser?.gene || state.selectedGene;
  ctx.fillText(geneName, W / 2, geneY + 18);

  // Upstream/downstream context when zoomed out
  if (zoom < 0.3) {
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = '#B0B0B0';
    // Upstream label (left of gene start)
    if (geneStartX > 30) {
      ctx.textAlign = 'left';
      ctx.fillText('\u2190 upstream genes', 4, geneY + 3);
    }
    // Downstream label (right of gene end)
    if (geneEndX < W - 30) {
      ctx.textAlign = 'right';
      ctx.fillText('downstream genes \u2192', W - 4, geneY + 3);
    }
  }
  if (zoom < 0.1) {
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = '#9CA3AF';
    ctx.textAlign = 'center';
    ctx.fillText('Chromosomal context \u2014 zoom out further for full view', W / 2, 28);
  }

  // Lollipop stems + heads
  for (const v of variants) {
    if (v.position == null) continue;
    const x = padding + ((v.position - minPos) / range) * plotW + panX;
    if (x < 0 || x > W) continue;

    const color = CLASS_COLORS[v.classification] || '#6B7280';
    const stemH = 40 + Math.random() * 20; // slight jitter to avoid overlap

    // Stem
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.moveTo(x, geneY);
    ctx.lineTo(x, geneY - stemH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Head
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, geneY - stemH, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Position labels
  ctx.fillStyle = '#9CA3AF';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(minPos.toLocaleString(), padding + panX, H - 6);
  ctx.textAlign = 'right';
  ctx.fillText(maxPos.toLocaleString(), padding + plotW + panX, H - 6);

  // Neighboring genomic context indicators
  const chrLabel = state.geneData.browser?.chromosome || (variants[0]?.chromosome ? `chr${variants[0].chromosome}` : '');
  const band = state.geneData.browser?.cytoband || '';
  ctx.font = '9px Inter, sans-serif';
  ctx.fillStyle = '#B0B0B0';
  ctx.textAlign = 'left';
  ctx.fillText(band ? `\u2190 ${chrLabel}${band} 5'` : '\u2190 5\' upstream', 2, 12);
  ctx.textAlign = 'right';
  ctx.fillText(band ? `3\' ${chrLabel}${band} \u2192` : '3\' downstream \u2192', W - 2, 12);

  // Store variant positions for hover
  canvas._variantPositions = variants.map(v => {
    if (v.position == null) return null;
    const x = padding + ((v.position - minPos) / range) * plotW + panX;
    return { x, variant: v };
  }).filter(Boolean);
}

function handleBrowserHover(e, canvas, tooltip) {
  if (!canvas._variantPositions) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let closest = null;
  let closestDist = 15;
  for (const vp of canvas._variantPositions) {
    const dist = Math.abs(vp.x - mx);
    if (dist < closestDist) {
      closestDist = dist;
      closest = vp;
    }
  }

  if (closest) {
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(closest.x, rect.width - 120) + 'px';
    tooltip.style.top = (my - 30) + 'px';
    const cls = CLASS_SHORT[closest.variant.classification] || closest.variant.classification;
    tooltip.textContent = `${closest.variant.hgvs || ''} (${cls}) chr${closest.variant.chromosome || '?'}:${closest.variant.position || '?'}`;
  } else {
    tooltip.style.display = 'none';
  }
}

// ── Chart: Drift (stacked area) ────────────────────────────────────────────
function renderDriftChart() {
  const wrap = h('div');
  const data = state.geneData.drift;
  if (!data || !data.snapshots || data.snapshots.length === 0) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No drift data available'));
    return wrap;
  }

  const canvas = h('canvas', { className: 'chart-canvas' });
  wrap.appendChild(canvas);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 140 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '140px';
    ctx.scale(dpr, dpr);
    const W = rect.width, H = 140;

    const snaps = data.snapshots;
    const keys = ['pathogenic', 'vus', 'benign'];
    const colors = { pathogenic: '#EF4444', vus: '#EAB308', benign: '#3B82F6' };
    const maxTotal = Math.max(...snaps.map(s => s.total || 1));
    const pad = { l: 30, r: 10, t: 10, b: 24 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    // Draw stacked areas
    for (let ki = keys.length - 1; ki >= 0; ki--) {
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + plotH);

      for (let i = 0; i < snaps.length; i++) {
        const x = pad.l + (i / Math.max(snaps.length - 1, 1)) * plotW;
        let stackVal = 0;
        for (let j = 0; j <= ki; j++) stackVal += snaps[i][keys[j]] || 0;
        const y = pad.t + plotH - (stackVal / maxTotal) * plotH;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(pad.l + plotW, pad.t + plotH);
      ctx.closePath();
      ctx.fillStyle = colors[keys[ki]];
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // X-axis labels
    ctx.fillStyle = '#9CA3AF';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < snaps.length; i++) {
      const x = pad.l + (i / Math.max(snaps.length - 1, 1)) * plotW;
      ctx.fillText(snaps[i].year || '', x, H - 6);
    }

    // Y-axis
    ctx.textAlign = 'right';
    ctx.fillText('0', pad.l - 4, pad.t + plotH);
    ctx.fillText(maxTotal.toLocaleString(), pad.l - 4, pad.t + 10);
  }));

  return wrap;
}

// ── Chart: Timeline (monthly bar chart) ────────────────────────────────────
function renderTimelineChart() {
  const wrap = h('div');
  const data = state.geneData.timeline;
  if (!data || !data.buckets || data.buckets.length === 0) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No timeline data available'));
    return wrap;
  }

  const canvas = h('canvas', { className: 'chart-canvas' });
  wrap.appendChild(canvas);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 140 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '140px';
    ctx.scale(dpr, dpr);
    const W = rect.width, H = 140;

    const buckets = data.buckets;
    const maxTotal = Math.max(...buckets.map(b => b.total || 1));
    const pad = { l: 30, r: 10, t: 10, b: 24 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const barW = Math.max(2, plotW / buckets.length - 1);

    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const x = pad.l + (i / buckets.length) * plotW;
      let y = pad.t + plotH;

      for (const key of ['pathogenic', 'likely_pathogenic', 'vus', 'likely_benign', 'benign']) {
        const val = b[key] || 0;
        if (val === 0) continue;
        const barH = (val / maxTotal) * plotH;
        y -= barH;
        ctx.fillStyle = CLASS_COLORS[key] || '#6B7280';
        ctx.fillRect(x, y, barW, barH);
      }
    }

    // X labels (every nth)
    ctx.fillStyle = '#9CA3AF';
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(buckets.length / 6));
    for (let i = 0; i < buckets.length; i += step) {
      const x = pad.l + (i / buckets.length) * plotW + barW / 2;
      const label = buckets[i].month || '';
      ctx.fillText(label.slice(0, 7), x, H - 6);
    }

    // Y-axis
    ctx.textAlign = 'right';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('0', pad.l - 4, pad.t + plotH);
    ctx.fillText(maxTotal.toString(), pad.l - 4, pad.t + 10);
  }));

  return wrap;
}

// ── Concordance Table ──────────────────────────────────────────────────────
function renderConcordance() {
  const wrap = h('div');
  const data = state.geneData.concordance;
  if (!data) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No concordance data'));
    return wrap;
  }

  // Concordance rate
  if (data.concordance_rate != null) {
    wrap.appendChild(h('div', {
      style: { fontSize: '12px', marginBottom: '8px', color: 'var(--text-secondary)' },
    }, [
      h('span', {}, 'Concordance rate: '),
      h('strong', { style: { color: data.concordance_rate > 80 ? 'var(--ben)' : 'var(--path)' } },
        `${data.concordance_rate}%`),
    ]));
  }

  const matrix = data.matrix || [];
  const discordant = matrix.filter(m => !m.concordant).slice(0, 8);

  if (discordant.length === 0) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No discordant variants'));
    return wrap;
  }

  const table = h('table', { className: 'conc-table' });
  const thead = h('thead', {}, [
    h('tr', {}, [
      h('th', {}, 'Variant'),
      h('th', {}, 'Classifications'),
      h('th', {}, 'Status'),
    ]),
  ]);
  table.appendChild(thead);

  const tbody = h('tbody');
  for (const row of discordant) {
    const classes = row.classifications || {};
    const classStr = Object.values(classes).slice(0, 3).join(', ');
    const tr = h('tr', {}, [
      h('td', { className: 'conc-hgvs', title: row.hgvs || '' }, row.hgvs || 'Unknown'),
      h('td', {}, classStr),
      h('td', {}, [
        h('span', { className: row.concordant ? 'conc-concordant' : 'conc-discordant' },
          row.concordant ? 'Concordant' : 'Discordant'),
      ]),
    ]);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ── Survival Curve ─────────────────────────────────────────────────────────
function renderSurvivalChart() {
  const wrap = h('div');
  const data = state.geneData.survival;
  if (!data || !data.points || data.points.length === 0) {
    wrap.appendChild(h('div', { className: 'empty-state' }, 'No survival data'));
    return wrap;
  }

  // Stats
  if (data.total_vus != null) {
    wrap.appendChild(h('div', {
      style: { fontSize: '11px', marginBottom: '6px', color: 'var(--text-secondary)' },
    }, `${data.total_resolved || 0} of ${data.total_vus} VUS resolved`));
  }

  const canvas = h('canvas', { className: 'chart-canvas' });
  wrap.appendChild(canvas);

  requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 140 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '140px';
    ctx.scale(dpr, dpr);
    const W = rect.width, H = 140;

    const points = data.points;
    const maxMonths = Math.max(...points.map(p => p.months || 0), 1);
    const pad = { l: 34, r: 10, t: 10, b: 24 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    // Grid
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 0.5;
    for (let f = 0; f <= 1; f += 0.25) {
      const y = pad.t + (1 - f) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    // Curve (Kaplan-Meier step style)
    ctx.beginPath();
    ctx.strokeStyle = '#8B5CF6';
    ctx.lineWidth = 2;
    let prevX = pad.l, prevY = pad.t;

    for (let i = 0; i < points.length; i++) {
      const x = pad.l + (points[i].months / maxMonths) * plotW;
      const y = pad.t + (1 - points[i].fraction) * plotH;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, prevY); // horizontal step
        ctx.lineTo(x, y); // vertical drop
      }
      prevX = x;
      prevY = y;
    }
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(prevX, pad.t + plotH);
    ctx.lineTo(pad.l, pad.t + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(139, 92, 246, 0.08)';
    ctx.fill();

    // Axes labels
    ctx.fillStyle = '#9CA3AF';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('100%', pad.l - 4, pad.t + 10);
    ctx.fillText('0%', pad.l - 4, pad.t + plotH);
    ctx.textAlign = 'center';
    ctx.fillText('0', pad.l, H - 6);
    ctx.fillText(`${maxMonths}mo`, pad.l + plotW, H - 6);
    ctx.fillText('Months since VUS submission', W / 2, H - 4);
  });

  return wrap;
}

// ── Export ──────────────────────────────────────────────────────────────────
function exportData(format) {
  if (state.variants.length === 0) return;
  const sep = format === 'tsv' ? '\t' : ',';
  const ext = format === 'tsv' ? 'tsv' : 'csv';

  const headers = ['hgvs', 'classification', 'chromosome', 'position', 'review_status', 'last_evaluated', 'clinvar_id'];
  const rows = [headers.join(sep)];

  for (const v of state.variants) {
    const row = headers.map(h => {
      let val = v[h] || '';
      if (typeof val === 'string' && (val.includes(sep) || val.includes('"') || val.includes('\n'))) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    rows.push(row.join(sep));
  }

  const blob = new Blob([rows.join('\n')], { type: format === 'tsv' ? 'text/tab-separated-values' : 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.selectedGene || 'vus'}_variants.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  render();
  // Start with 7d (fast, small dataset)
  const df = dateFrom(state.timeRange);
  const params = {};
  if (df) params.date_from = df;
  try {
    const period = state.timeRange === 'all' ? 'all' : state.timeRange;
    const [statsRes, genesRes, tlRes, condRes] = await Promise.allSettled([
      api('/stats', params),
      api('/genes', { ...params, per_page: 100, sort: 'total_variants', order: 'desc' }),
      api('/submissions-timeline', params),
      api('/phenotype/top', { period }),
    ]);
    if (statsRes.status === 'fulfilled') state.stats = statsRes.value.data;
    if (genesRes.status === 'fulfilled') state.genes = (genesRes.value.data || []).sort((a, b) => (b.total_variants || 0) - (a.total_variants || 0));
    state.submissionsTimeline = tlRes.status === 'fulfilled' ? tlRes.value.data?.buckets : null;
    state.submissionsGranularity = tlRes.status === 'fulfilled' ? tlRes.value.data?.granularity : null;
    if (condRes.status === 'fulfilled') { state.topConditions = condRes.value.data || []; state.conditionListPage = 0; }
  } catch (e) {
    console.error('Init error:', e);
  }
  render();
  renderSubmissionsChart();

  // Background: preload "all" stats for instant switch later
  Promise.allSettled([
    api('/stats'),
    api('/genes', { per_page: 100, sort: 'total_variants', order: 'desc' }),
    api('/submissions-timeline'),
  ]).catch(() => {});
}

init();
