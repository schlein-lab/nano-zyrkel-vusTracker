// nano-zyrkel-vusTracker — API-powered. Data from vus.zyrkel.com.
const API_BASE = 'https://vus.zyrkel.com/api/v1';
const API_KEY = '781a2daba1bac1a74bcf3e58a630732fb3a63fec9dcb232b623e4cc5c8491ec4';
let focusGene = '', activeRange = 'all', searchTimeout = null, acIndex = -1;
const currentFilters = { gene:'', classification:[], date_from:'', page:1 };
const $ = id => document.getElementById(id);
let lastHeroGene = '', statsCache = null;
const apiCache = new Map();

async function api(path, params = {}) {
  params.api_key = API_KEY;
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k,v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const key = url.toString(), cached = apiCache.get(key);
  if (cached && Date.now() - cached.ts < 300000) return cached.data;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const json = await r.json();
  apiCache.set(key, { data: json, ts: Date.now() });
  return json;
}

window.toggleSection = function(el) {
  const body = el.nextElementSibling;
  if (body) { el.classList.toggle('collapsed'); body.classList.toggle('collapsed'); }
};

function animateNumber(el, target, dur = 800) {
  const t0 = performance.now();
  (function frame(now) {
    const p = Math.min((now - t0) / dur, 1);
    el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}

async function init() {
  try {
    $('hero-number').textContent = 'Loading...';
    statsCache = await api('/stats');
    $('search').addEventListener('input', onSearchInput);
    $('search').addEventListener('keydown', onSearchKeydown);
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) hideAutocomplete(); });
    const params = new URLSearchParams(location.search);
    if (params.get('embed') === 'true') document.body.classList.add('embed');
    const g = params.get('gene');
    if (g) await selectGene(g.toUpperCase()); else renderOverview();
  } catch (e) {
    console.error('Init failed:', e);
    $('hero-number').textContent = 'Error'; $('hero-subtitle').textContent = e.message;
  }
}

async function renderOverview() {
  $('overview-mode').style.display = ''; $('gene-mode').style.display = 'none'; $('clear-btn').style.display = 'none';
  const d = statsCache?.data;
  if (d) {
    const h = $('hero-number');
    if (lastHeroGene !== '_ov') { animateNumber(h, d.total_variants || 0); lastHeroGene = '_ov'; }
    else h.textContent = fmt(d.total_variants || 0);
    $('hero-subtitle').textContent = `${fmt(d.total_reclassifications||0)} reclassifications · ${fmt(d.total_genes||0)} genes`;
  }
  try {
    const resp = await api('/genes', { per_page: 15, sort: 'vus_count', order: 'desc' });
    const genes = resp.data || [], el = $('top-genes-section');
    if (!genes.length) { el.innerHTML = ''; return; }
    const max = genes[0]?.vus_count || 1;
    el.innerHTML = '<div class="section-title" onclick="toggleSection(this)">Top Genes by VUS</div><div class="section-body">' +
      genes.map(g => `<div class="row clickable-row" onclick="selectGene('${esc(g.symbol)}')" style="cursor:pointer"><span class="gene">${esc(g.symbol)}</span><span class="val">${fmt(g.total_variants)} · ${fmt(g.vus_count)} VUS</span></div><div class="bar" style="width:${Math.round(g.vus_count/max*100)}%"></div>`).join('') + '</div>';
  } catch(e) {}
}

window.selectGene = async function(gene) {
  gene = gene.toUpperCase(); hideAutocomplete();
  focusGene = gene; currentFilters.gene = gene; currentFilters.page = 1;
  $('search').value = gene;
  history.replaceState(null, '', '?gene=' + encodeURIComponent(gene));
  $('overview-mode').style.display = 'none'; $('gene-mode').style.display = ''; $('clear-btn').style.display = '';
  showLoading(`loading ${gene}...`);
  try {
    const g = (await api(`/genes/${gene}`)).data;
    const h = $('hero-number');
    if (lastHeroGene !== gene) { animateNumber(h, g.total_variants); lastHeroGene = gene; }
    else h.textContent = fmt(g.total_variants);
    $('hero-subtitle').textContent = `${esc(gene)} — ${fmt(g.total_variants)} variants`;
    renderGeneHeader(g); renderFilterBar();

    const [vars, tl, conc, surv, drift, br] = await Promise.allSettled([
      api(`/genes/${gene}/variants`, { per_page: 50 }),
      api(`/genes/${gene}/timeline`),
      api(`/genes/${gene}/concordance`),
      api(`/genes/${gene}/survival`),
      api(`/genes/${gene}/drift`),
      api(`/genes/${gene}/genome-browser`),
    ]);
    hideLoading();
    if (vars.status === 'fulfilled') renderVariantList(vars.value);
    if (drift.status === 'fulfilled') renderDrift(drift.value.data);
    if (tl.status === 'fulfilled') renderTimeline(tl.value.data);
    if (conc.status === 'fulfilled') renderConcordance(conc.value.data);
    if (surv.status === 'fulfilled') renderSurvival(surv.value.data);
    if (br.status === 'fulfilled') renderGenomeBrowser(br.value.data);
  } catch(e) {
    hideLoading();
    $('gene-header').innerHTML = `<span style="color:#dc2626;font-size:10px;">Error: ${esc(e.message)}</span>`;
  }
};
window.clearGene = function() { focusGene=''; $('search').value=''; history.replaceState(null,'',location.pathname); renderOverview(); };

function renderGeneHeader(g) {
  const el = $('gene-header'); if (!el) return;
  const cc = g.classification_counts||{};
  const p=(cc.pathogenic||0)+(cc.likely_pathogenic||0), b=(cc.benign||0)+(cc.likely_benign||0), v=cc.uncertain_significance||0, co=cc.conflicting||0, t=g.total_variants||1;
  let links='';
  if(g.omim_id)links+=` <a href="https://omim.org/entry/${g.omim_id}" target="_blank" class="gene-link">OMIM</a>`;
  if(g.medgen_id)links+=` <a href="https://www.ncbi.nlm.nih.gov/medgen/${g.medgen_id}" target="_blank" class="gene-link">MedGen</a>`;
  let cond='';
  if(g.conditions?.length) cond='<div class="gene-conditions">'+g.conditions.filter(c=>!c.includes('not provided')&&!c.includes('not specified')).slice(0,4).map(c=>`<span class="condition-tag">${esc(c.substring(0,40))}</span>`).join('')+'</div>';
  el.innerHTML=`<div class="gene-header-top"><span class="gene-name">${esc(g.symbol)}</span>${links}</div><div class="gene-stats"><span class="gene-stat"><span class="badge-sm badge-path">Path</span> ${fmt(p)}</span><span class="gene-stat"><span class="badge-sm badge-vus">VUS</span> ${fmt(v)}</span><span class="gene-stat"><span class="badge-sm badge-benign">Ben</span> ${fmt(b)}</span><span class="gene-stat" style="color:#64748b">Total: ${fmt(t)}</span></div><div class="gene-donut">${donutSVG(p,v,b,co,t)}</div>${cond}`;
  // classification bar
  const secs=[{l:'Path',c:cc.pathogenic||0,col:'#dc2626'},{l:'LP',c:cc.likely_pathogenic||0,col:'#f59e0b'},{l:'VUS',c:v,col:'#eab308'},{l:'LB',c:cc.likely_benign||0,col:'#22c55e'},{l:'Ben',c:cc.benign||0,col:'#16a34a'}].filter(s=>s.c>0);
  let x=0; const barSVG=secs.map(s=>{const w=(s.c/t)*380;const r=`<rect x="${x+10}" y="2" width="${Math.max(w,1)}" height="16" rx="2" fill="${s.col}" opacity="0.85"><title>${s.l}: ${fmt(s.c)}</title></rect>`;const lb=w>25?`<text x="${x+10+w/2}" y="13" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">${s.l}</text>`:'';x+=w;return r+lb;}).join('');
  const dr=$('drift-section');if(dr)dr.innerHTML=`<div class="section-title">Classification Distribution</div><svg viewBox="0 0 400 22" style="width:100%;height:22px">${barSVG}</svg>`;
}

function donutSVG(p,v,b,co,t){if(t<=0)return '';const r=16,cx=20,cy=20,sw=6,ci=2*Math.PI*r;const sg=[{v:p,c:'#dc2626'},{v:v,c:'#ca8a04'},{v:b,c:'#16a34a'},{v:co,c:'#d97706'}].filter(s=>s.v>0);let o=0;return`<svg viewBox="0 0 40 40" style="width:36px;height:36px">${sg.map(s=>{const l=(s.v/t)*ci,oo=o;o+=l;return`<circle class="donut-segment" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.c}" stroke-width="${sw}" stroke-dasharray="${l} ${ci-l}" stroke-dashoffset="${-oo}"/>`;}).join('')}</svg>`;}

function renderFilterBar(){const el=$('filter-bar');if(!el)return;const all=[['pathogenic','Path'],['likely_pathogenic','LP'],['uncertain_significance','VUS'],['likely_benign','LB'],['benign','Ben']];el.innerHTML='<div class="filter-chips">'+all.map(([c,l])=>{const a=!currentFilters.classification.length||currentFilters.classification.includes(c);return`<button class="filter-chip ${a?'active':''}" onclick="toggleClass('${c}')">${l}</button>`;}).join('')+'</div>';}
window.toggleClass=function(c){const i=currentFilters.classification.indexOf(c);if(i>=0)currentFilters.classification.splice(i,1);else currentFilters.classification.push(c);renderFilterBar();reloadVariants();};
async function reloadVariants(){if(!focusGene)return;try{const p={per_page:50};if(currentFilters.classification.length)p.classification=currentFilters.classification.join(',');if(currentFilters.date_from)p.date_from=currentFilters.date_from;renderVariantList(await api(`/genes/${focusGene}/variants`,p));}catch(e){}}
function renderVariantList(resp){const el=$('variant-list'),vs=resp?.data||[],total=resp?.total||vs.length;if(!vs.length){el.innerHTML='<div style="color:#94a3b8;font-size:10px;padding:4px 0">No variants.</div>';return;}el.innerHTML=`<div style="color:#0f766e;font-size:9px;margin-bottom:2px">${fmt(total)} variants</div>`+vs.map(v=>`<div class="variant-row clickable-row" onclick="toggleCard(this)" data-variant='${esc(JSON.stringify(v))}'><span class="gene">${esc(focusGene)}</span><span class="hgvs">${esc((v.hgvs||'').substring(0,35))}</span><span class="badge-sm ${badgeClass(v.classification)}">${shortClass(v.classification)}</span></div>`).join('');}

window.toggleCard=function(row){const nx=row.nextElementSibling;if(nx?.classList.contains('card-expanded')){nx.remove();return;}document.querySelectorAll('.card-expanded').forEach(c=>c.remove());try{const v=JSON.parse(row.dataset.variant),sc=shortClass(v.classification),cc={'path.':'card-path','l.path.':'card-lpath','VUS':'card-vus','l.ben.':'card-lben','benign':'card-ben'}[sc]||'';let ph='';if(v.phenotype_ids){const pi=typeof v.phenotype_ids==='string'?JSON.parse(v.phenotype_ids):v.phenotype_ids;if(pi?.omim?.length)ph+=pi.omim.map(id=>`<a href="https://omim.org/entry/${id}" target="_blank" class="gene-link">OMIM:${id}</a> `).join('');if(pi?.medgen?.length)ph+=pi.medgen.map(id=>`<a href="https://www.ncbi.nlm.nih.gov/medgen/${id}" target="_blank" class="gene-link">MedGen:${id}</a> `).join('');}row.insertAdjacentHTML('afterend',`<div class="card-expanded"><div class="card ${cc}"><div class="card-header"><span class="card-gene">${esc(focusGene)}</span><span class="badge-sm ${badgeClass(v.classification)}">${sc}</span></div><div class="card-hgvs">${esc(v.hgvs||'')}</div><div class="card-meta"><span><b>Condition:</b> ${esc((v.condition||'—').substring(0,60))}</span><span><b>Review:</b> ${esc((v.review_status||'—').substring(0,30))}</span>${ph?`<span><b>Phenotype:</b> ${ph}</span>`:''}<span><a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${v.variation_id}/" target="_blank" style="color:#0f766e;text-decoration:underline;font-size:9px">ClinVar →</a></span></div></div></div>`);}catch(e){}};

window.setRange=function(range){activeRange=range;document.querySelectorAll('.tb').forEach(b=>b.classList.remove('active'));event.target.classList.add('active');currentFilters.date_from=range!=='all'?rangeToDate(range):'';if(focusGene)reloadVariants();};
function rangeToDate(r){const d=new Date();if(r==='7d')d.setDate(d.getDate()-7);else if(r==='1m')d.setMonth(d.getMonth()-1);else if(r==='1y')d.setFullYear(d.getFullYear()-1);else if(r==='5y')d.setFullYear(d.getFullYear()-5);else return '';return d.toISOString().slice(0,10);}

function onSearchInput(e){const q=e.target.value.trim();clearTimeout(searchTimeout);if(q.length<2){hideAutocomplete();return;}searchTimeout=setTimeout(async()=>{try{const r=await api('/search',{q});showAutocomplete(r.data?.genes||[],r.data?.conditions||[]);}catch(e){hideAutocomplete();}},250);}
function onSearchKeydown(e){const items=$('autocomplete').querySelectorAll('.ac-item');if(!items.length)return;if(e.key==='ArrowDown'){e.preventDefault();acIndex=Math.min(acIndex+1,items.length-1);items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex));}else if(e.key==='ArrowUp'){e.preventDefault();acIndex=Math.max(acIndex-1,0);items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex));}else if(e.key==='Enter'){e.preventDefault();const sel=acIndex>=0?items[acIndex]:items.length===1?items[0]:null;if(sel?.dataset.gene)selectGene(sel.dataset.gene);}else if(e.key==='Escape')hideAutocomplete();}
function showAutocomplete(genes,conds){const ac=$('autocomplete');acIndex=-1;if(!genes.length&&!conds.length){ac.innerHTML='<div class="ac-item" style="color:#94a3b8;pointer-events:none">No results</div>';ac.classList.add('visible');return;}ac.innerHTML=genes.map(g=>`<div class="ac-item" data-gene="${esc(g.symbol)}" onclick="selectGene('${esc(g.symbol)}')"><span>${esc(g.symbol)}</span><span class="ac-count">${fmt(g.total_variants||0)}</span></div>`).join('');ac.classList.add('visible');}
function hideAutocomplete(){$('autocomplete').classList.remove('visible');acIndex=-1;}

// ── Visualizations ─────────────────────────────────────────
function renderDrift(data){const el=$('drift-section');if(!el)return;const sn=data?.snapshots;if(!sn?.length||sn.length<2)return;const n=sn.length,w=400,h=80,xs=(w-20)/(n-1),pts=[];for(let i=0;i<n;i++){const s=sn[i],t=(s.pathogenic||0)+(s.vus||0)+(s.benign||0),x=10+i*xs;if(!t){pts.push({x,pY:h-10,vY:h-10});continue;}const a=h-20;pts.push({x,pY:10+(1-(s.pathogenic||0)/t)*a,vY:10+(1-(s.pathogenic||0)/t-(s.vus||0)/t)*a});}const ar=(u,l)=>u.map((v,i)=>`${pts[i].x},${v}`).join(' ')+' '+[...l].reverse().map((v,i)=>`${pts[n-1-i].x},${v}`).join(' ');el.innerHTML=`<div class="section-title" onclick="toggleSection(this)">Classification Drift</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px"><polygon points="${ar(pts.map(()=>10),pts.map(p=>p.vY))}" fill="#0f766e" opacity="0.6"/><polygon points="${ar(pts.map(p=>p.vY),pts.map(p=>p.pY))}" fill="#d97706" opacity="0.6"/><polygon points="${ar(pts.map(p=>p.pY),pts.map(()=>h-10))}" fill="#dc2626" opacity="0.6"/><text x="10" y="${h-1}" fill="#64748b" font-size="9">${sn[0].year}</text><text x="${w-10}" y="${h-1}" text-anchor="end" fill="#64748b" font-size="9">${sn[n-1].year}</text></svg></div>`;}

function renderTimeline(data){const el=$('timeline-section');if(!el)return;const bk=data?.buckets;if(!bk?.length){el.innerHTML='';return;}const n=bk.length,w=400,h=80,pl=30,pr=5,pt=5,pb=18,pw=w-pl-pr,ph=h-pt-pb;const cats=bk.map(b=>({p:(b.pathogenic||0)+(b.likely_pathogenic||0),v:b.vus||0,b:(b.benign||0)+(b.likely_benign||0),t:b.total||0}));const mx=Math.max(1,...cats.map(c=>c.t)),xA=i=>pl+(i/Math.max(1,n-1))*pw,yA=v=>pt+ph-(v/mx)*ph;const ap=(u,l)=>'M'+u.map((v,i)=>`${xA(i)},${yA(v)}`).join(' L')+' L'+[...l].reverse().map((v,i)=>`${xA(n-1-i)},${yA(v)}`).join(' L')+' Z';const st=Math.max(1,Math.floor(n/5));const lb=bk.filter((_,i)=>i%st===0||i===n-1).map(b=>`<text x="${xA(bk.indexOf(b))}" y="${h-2}" text-anchor="middle" fill="#64748b" font-size="9">${(b.month||'').slice(2,7)}</text>`).join('');el.innerHTML=`<div class="section-title" onclick="toggleSection(this)">Submissions Timeline</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:80px"><path d="${ap(cats.map(c=>c.b),cats.map(()=>0))}" fill="#16a34a" opacity="0.5"/><path d="${ap(cats.map(c=>c.b+c.v),cats.map(c=>c.b))}" fill="#eab308" opacity="0.5"/><path d="${ap(cats.map(c=>c.t),cats.map(c=>c.b+c.v))}" fill="#dc2626" opacity="0.5"/>${lb}</svg></div>`;}

function renderConcordance(data){const el=$('concordance-section');if(!el)return;if(!data?.matrix?.length){el.innerHTML='';return;}const rate=data.concordance_rate!=null?` (${(data.concordance_rate*100).toFixed(0)}%)`:'';const rows=data.matrix.slice(0,15).map(r=>{const subs=Object.entries(r.classifications||{}).map(([s,c])=>`<span class="badge-sm ${badgeClass(c)}" title="${esc(s)}">${shortClass(c)}</span>`).join(' ');return`<tr><td style="font-size:9px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.hgvs)}">${esc((r.hgvs||'').substring(0,35))}</td><td>${subs}</td><td style="color:${r.concordant?'#16a34a':'#dc2626'};font-weight:600">${r.concordant?'✓':'✗'}</td></tr>`;}).join('');el.innerHTML=`<div class="section-title" onclick="toggleSection(this)">Concordance${rate}</div><div class="section-body"><table style="width:100%;border-collapse:collapse;font-size:9px"><thead><tr style="color:#94a3b8"><th>Variant</th><th>Class</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;}

function renderSurvival(data){const el=$('survival-section');if(!el)return;const pts=data?.points;if(!pts?.length||pts.length<2){el.innerHTML='';return;}const w=400,h=100,pl=30,pr=10,pt=10,pb=20,pw=w-pl-pr,ph=h-pt-pb;const mx=Math.max(1,pts[pts.length-1].months||1),xA=d=>pl+(d/mx)*pw,yA=f=>pt+ph-f*ph;const line=pts.map(p=>`${xA(p.months)},${yA(p.fraction)}`).join(' L');const grid=[0.25,0.5,0.75].map(f=>`<line x1="${pl}" y1="${yA(f)}" x2="${w-pr}" y2="${yA(f)}" stroke="#f1f5f9" stroke-width="0.5"/>`).join('');el.innerHTML=`<div class="section-title" onclick="toggleSection(this)">VUS Survival</div><div class="section-body"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100px">${grid}<polyline points="${line}" fill="none" stroke="#0f766e" stroke-width="1.5"/></svg><div style="font-size:8px;color:#64748b;margin-top:2px">${fmt(data.total_vus||0)} VUS · ${fmt(data.total_resolved||0)} resolved</div></div>`;}

function renderGenomeBrowser(data){const el=$('genome-browser');if(!el)return;const vs=(data?.variants||[]).filter(v=>v.position>0);if(!vs.length){el.innerHTML='<div style="color:#94a3b8;font-size:9px">No genomic coordinates</div>';return;}const mn=vs[0].position,mx=vs[vs.length-1].position,sp=mx-mn||1,chr=vs[0].chromosome||'?';let vS=mn-sp*0.05,vE=mx+sp*0.05;function render(){const vSp=vE-vS,w=400,h=70,toX=p=>((p-vS)/vSp)*w;const clsC=c=>{const s=shortClass(c);return s.includes('path')?'#dc2626':s==='VUS'?'#eab308':s.includes('ben')?'#16a34a':'#94a3b8';};const vis=vs.filter(v=>v.position>=vS&&v.position<=vE);let svg='';if(vis.length>200){const bins=Array.from({length:w},()=>({p:0,v:0,b:0,t:0}));for(const v of vis){const x=Math.floor(toX(v.position));if(x>=0&&x<w){bins[x].t++;const s=shortClass(v.classification);if(s.includes('path'))bins[x].p++;else if(s==='VUS')bins[x].v++;else bins[x].b++;}}for(let x=0;x<w;x++){if(!bins[x].t)continue;const f=Math.min(bins[x].t/5,1);const mc=bins[x].p>bins[x].v?'#dc2626':bins[x].v>bins[x].b?'#eab308':'#16a34a';svg+=`<rect x="${x}" y="20" width="1" height="${30*f+5}" fill="${mc}" opacity="${0.3+f*0.7}"/>`;}}else{for(const v of vis){const x=toX(v.position).toFixed(1),c=clsC(v.classification);svg+=`<line x1="${x}" y1="50" x2="${x}" y2="25" stroke="${c}" stroke-width="1" opacity="0.6"/><circle cx="${x}" cy="22" r="3" fill="${c}" opacity="0.8"><title>${v.hgvs||''}\nchr${chr}:${v.position}</title></circle>`;}}let ax='';for(let i=0;i<=5;i++){const p=vS+(vSp*i/5),x=(i/5)*w,lb=p>=1e6?(p/1e6).toFixed(2)+'M':p>=1e3?(p/1e3).toFixed(0)+'K':p.toFixed(0);ax+=`<text x="${x}" y="66" text-anchor="middle" fill="#64748b" font-size="7">${lb}</text>`;}el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px"><span style="font-size:8px;color:#64748b">chr${chr}:${Math.round(vS)}–${Math.round(vE)} (${vis.length})</span><span style="display:flex;gap:2px"><button onclick="bZ(0.5)" class="br-btn">+</button><button onclick="bZ(2)" class="br-btn">−</button><button onclick="bP(-0.3)" class="br-btn">←</button><button onclick="bP(0.3)" class="br-btn">→</button><button onclick="bR()" class="br-btn">⟲</button></span></div><svg viewBox="0 0 ${w} 70" style="width:100%;height:70px"><rect x="0" y="12" width="${w}" height="4" rx="2" fill="#e2e8f0"/><rect x="${toX(mn)}" y="12" width="${Math.max(toX(mx)-toX(mn),2)}" height="4" rx="2" fill="#0f766e" opacity="0.3"/><text x="${toX(mn)}" y="9" fill="#0f766e" font-size="8" font-weight="600">${data.gene}</text>${svg}<line x1="0" y1="55" x2="${w}" y2="55" stroke="#e2e8f0" stroke-width="0.5"/>${ax}</svg>`;}window.bZ=function(f){const c=(vS+vE)/2,hs=((vE-vS)/2)*f;vS=c-hs;vE=c+hs;render();};window.bP=function(f){const s=(vE-vS)*f;vS+=s;vE+=s;render();};window.bR=function(){vS=mn-sp*0.05;vE=mx+sp*0.05;render();};el.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY>0?1.3:0.7;const rc=el.querySelector('svg')?.getBoundingClientRect();if(!rc)return;const mx2=(e.clientX-rc.left)/rc.width;const mp=vS+mx2*(vE-vS);vS=mp-(mp-vS)*f;vE=mp+(vE-mp)*f;render();},{passive:false});render();}

window.doExport=async function(format){if(!focusGene)return;try{const resp=await api(`/genes/${focusGene}/variants`,{per_page:5000});const vs=resp.data||[],sep=format==='tsv'?'\t':',';const hdr=['gene','hgvs','classification','condition','chromosome','position'].join(sep);const rows=vs.map(v=>[focusGene,v.hgvs,v.classification,v.condition||'',v.chromosome||'',v.position||''].map(f=>`"${String(f).replace(/"/g,'""')}"`).join(sep));const blob=new Blob([hdr+'\n'+rows.join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${focusGene}.${format}`;a.click();}catch(e){}};
window.shareLink=function(){navigator.clipboard?.writeText(location.href);};

function fmt(n){return n==null?'—':Number(n).toLocaleString();}
function esc(s){if(!s)return '';const d=document.createElement('div');d.textContent=String(s);return d.innerHTML;}
function shortClass(c){return{pathogenic:'path.',likely_pathogenic:'l.path.',uncertain_significance:'VUS',likely_benign:'l.ben.',benign:'benign',conflicting:'confl.',not_provided:'n/a'}[c]||c||'';}
function badgeClass(c){return{pathogenic:'badge-path',likely_pathogenic:'badge-path',uncertain_significance:'badge-vus',likely_benign:'badge-benign',benign:'badge-benign',conflicting:'badge-confl'}[c]||'';}
function showLoading(msg){$('loading').style.display='';$('loading-text').textContent=msg||'loading...';}
function hideLoading(){$('loading').style.display='none';}

init();
