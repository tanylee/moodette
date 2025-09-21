async function loadJSON(u){
  const res = await fetch(u, { cache: "no-store" });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  return res.json();
}
function priceFmt(p){ if(!p) return ""; const n=parseFloat(String(p).replace(",",".")); return isFinite(n)?`$${n.toFixed(2)}`:p; }
function el(html){ const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstElementChild; }

function card(p){
  return el(`
    <div class="card">
      <img loading="lazy" src="${p.images?.[0]||""}" alt="${p.title||""}">
      <div class="meta">
        <div class="title">${p.title||""}</div>
        <div class="price">${priceFmt(p.price)}</div>
        <a class="btn-temu" href="${p.out_url}" target="_blank" rel="nofollow sponsored noopener" aria-label="Get it on Temu: ${p.title||""}">
          GET IT ON TEMU
        </a>
      </div>
    </div>
  `);
}

function emptyState(reason){
  const box = document.getElementById("grid");
  box.innerHTML = "";
  box.appendChild(el(`
    <div style="padding:24px;color:#666">
      <div style="font-weight:700;margin-bottom:6px">Пока нет товаров</div>
      <div>${reason}</div>
    </div>
  `));
}

async function setup(){
  try{
    // ABS-пути, чтобы исключить ошибки относительных путей на Netlify
    const productsAll = await loadJSON("/data/products.json");
    const categories  = await loadJSON("/config/categories.json");

    // Рисуем чипсы
    const nav = document.getElementById("cats");
    categories.forEach(c=>{
      const a=document.createElement("a");
      a.href=`#/niche/${c.slug}`;
      a.textContent=c.title;
      nav.appendChild(a);
    });

    // Фильтруем недоступные (OOS скрываем)
    const products = Array.isArray(productsAll) ? productsAll.filter(p=>p.available!==false) : [];

    function highlightActive(){
      const m = location.hash.match(/#\/niche\/(.+)$/);
      [...nav.querySelectorAll("a")].forEach(a=>a.classList.remove("active"));
      if(m){ const a = nav.querySelector(`a[href="#/niche/${m[1]}"]`); if(a) a.classList.add("active"); }
    }

    function render(){
      const m = location.hash.match(/#\/niche\/(.+)$/);
      const list = m ? products.filter(p=>p.category===m[1]) : products;
      const grid = document.getElementById("grid");
      grid.innerHTML = "";
      if(!list.length){
        emptyState("Запусти обновление в GitHub Actions или проверь, что в Google Sheet есть доступные товары.");
        return;
      }
      list.forEach(p=>grid.appendChild(card(p)));
      highlightActive();
    }

    addEventListener("hashchange", render);
    render();
  }catch(err){
    console.error("[app] failed to load data:", err);
    emptyState(`Не удалось загрузить данные: ${String(err.message||err)}. Проверь, что на сайте есть файл <code>/data/products.json</code>.`);
  }
}
setup();
