async function load(u){return (await fetch(u)).json();}
function priceFmt(p){if(!p)return'';const n=parseFloat(String(p).replace(',','.'));return isFinite(n)?`$${n.toFixed(2)}`:p;}
function card(p){
  const el=document.createElement('div');
  el.className='card';
  el.innerHTML=`<img loading="lazy" src="${p.images?.[0]||''}" alt="${p.title}">
  <div class="meta"><div>${p.title}</div><div>${priceFmt(p.price)}</div>
  <a class="btn-temu" href="${p.out_url}" target="_blank" rel="nofollow noopener">Get It on Temu</a></div>`;
  return el;
}
async function setup(){
  const all=await load('./data/products.json');
  const products=all.filter(p=>p.available!==false);
  const cats=await load('./config/categories.json');
  const nav=document.getElementById('cats');
  cats.forEach(c=>{const a=document.createElement('a');a.href=`#/niche/${c.slug}`;a.textContent=c.title;nav.appendChild(a);});
  function render(){
    const m=location.hash.match(/#\/niche\/(.+)$/);
    const list=m?products.filter(p=>p.category===m[1]):products;
    const grid=document.getElementById('grid');grid.innerHTML='';
    list.forEach(p=>grid.appendChild(card(p)));
  }
  addEventListener('hashchange',render);render();
}
setup();
