const qs=(s,r=document)=>r.querySelector(s);const slug=s=>(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
const withUtm=(url,utm)=>{try{const u=new URL(url);if(utm){const qp=new URLSearchParams(utm);[...qp.entries()].forEach(([k,v])=>u.searchParams.set(k,v))}return u.toString()}catch{return url}};
async function loadJSON(p){const r=await fetch(p,{cache:"no-store"});if(!r.ok)throw new Error(p+' '+r.status);return await r.json()}
function tmplFeatured(p,utm){const hasImage=p.image||(p.images&&p.images[0]);const img=p.image||(p.images&&p.images[0]);return `<section class="featured">
${hasImage?`<div><img src="${img}" alt="${p.title||p.id}" style="width:100%;height:100%;object-fit:cover;max-height:560px"></div>`:`<div class="visual"><div class="tag">${p.id}</div></div>`}
<div class="info"><div class="muted" style="margin-bottom:6px;">Featured</div>
<h1 style="font-size:1.8rem;line-height:1.25;margin:0 0 6px;">${p.title||('Temu link — '+p.id)}</h1>
${p.price?`<div class="price">$${Number(p.price).toFixed(2)}</div>`:``}
<div class="pill">Direct affiliate</div> <div class="pill">Safe redirect</div>
<p><a class="btn" href="${withUtm(p.affiliate_url, 'utm_source=pinterest&utm_medium=affiliate&utm_campaign=moodette')}" target="_blank" rel="nofollow sponsored">Go to Temu</a></p>
<div class="muted" style="margin-top:12px;font-size:.92rem">This page contains Temu affiliate links.</div></div></section>`}
function tmplCard(p){const hasImage=p.image||(p.images&&p.images[0]);const img=p.image||(p.images&&p.images[0]);return `<article class="card">
${hasImage?`<img src="${img}" alt="${p.title||p.id}" loading="lazy">`:`<div class="visual"><div class="tag">${p.id}</div></div>`}
<div class="cbody"><div class="title">${p.title||('Temu link — '+p.id)}</div>
${p.price?`<div class="muted" style="margin-bottom:10px">$${Number(p.price).toFixed(2)}</div>`:`<div style="height:18px"></div>`}
<a class="btn" style="width:100%;text-align:center" href="${withUtm(p.affiliate_url, 'utm_source=pinterest&utm_medium=affiliate&utm_campaign=moodette')}" target="_blank" rel="nofollow sponsored">Go to Temu</a></div></article>`}
(async function start(){try{const cfg=await loadJSON('./data/site.json');const products=await loadJSON('./data/products.json');qs('#brand').textContent=cfg.brand||'Moodette';
const app=qs('#app');const cats=[...new Set(products.map(p=>p.category).filter(Boolean))];
const tools=document.createElement('div');tools.className='tools';tools.innerHTML=`<input class="search" id="search" type="search" placeholder="Search titles or tags…"><select class="select" id="cat"><option value="">All categories</option>${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>`;app.appendChild(tools);
const featured=document.createElement('div');featured.innerHTML=tmplFeatured(products[0]);app.appendChild(featured);
const grid=document.createElement('section');grid.id='catalog';grid.className='grid';grid.innerHTML=`<div style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px;margin:6px 2px 12px">${cats.map(c=>`<a class="pill" href="#cat-${slug(c)}">${c}</a>`).join('')}</div><div class="cards" id="cards">${products.slice(1,60).map(tmplCard).join('')}</div>`;app.appendChild(grid);
const search=qs('#search');const select=qs('#cat');const rerender=()=>{const q=(search.value||'').toLowerCase().trim();const c=select.value||'';const filtered=products.slice(1).filter(p=>{const hitQ=!q||(p.title||'').toLowerCase().includes(q)||(p.tags||[]).join(' ').toLowerCase().includes(q);const hitC=!c||p.category===c;return hitQ&&hitC});qs('#cards').innerHTML=filtered.map(tmplCard).join('')||"<div class='muted' style='padding:12px'>No items yet.</div>"};
search.addEventListener('input',rerender);select.addEventListener('change',rerender);
const onHash=()=>{const h=(location.hash||'').slice(1);if(h.startsWith('cat-')){const c=h.slice(4);select.value=c;rerender();window.scrollTo({top:qs('#catalog').offsetTop-10,behavior:'smooth'})}};addEventListener('hashchange',onHash);onHash();
}catch(e){qs('#app').innerHTML="<div class='muted' style='padding:60px 0;text-align:center'>No products yet. Waiting for the sheet → scraper to fill data/products.json</div>";console.error(e)}})();
