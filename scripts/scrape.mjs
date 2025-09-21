import 'dotenv/config';
import { chromium, devices } from 'playwright';
import { parse } from 'papaparse';
import { request } from 'undici';
import fs from 'fs/promises';
import path from 'path';
import slugify from 'slugify';

const MOBILE = devices['iPhone 12'];
const SHEET_CSV_URL = process.env.SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQhtr6CpyCHI8kc7kEV1G15pN32o-rJqqpjpC7D9XFq54OieEwMsrsIDUVaLF6cngubAs4e8847CD7X/pub?gid=0&single=true&output=csv';

const MAX_ROWS = parseInt(process.env.MAX_ROWS || '80', 10);
const RECHECK_EXISTING = parseInt(process.env.RECHECK_EXISTING || '40', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);
const REDIRECT_TIMEOUT = parseInt(process.env.REDIRECT_TIMEOUT || '15000', 10);
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '20000', 10);

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const PRODUCTS_PATH = path.join(PUBLIC, 'data', 'products.json');
const CATEGORIES_PATH = path.join(PUBLIC, 'config', 'categories.json');

async function ensureDirs(){ await fs.mkdir(path.dirname(PRODUCTS_PATH), { recursive: true }); }
async function readJSON(p){ try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
async function writeJSON(p, d){ await fs.writeFile(p, JSON.stringify(d, null, 2)); }

async function sheetRows(){
  const { body } = await request(SHEET_CSV_URL);
  const parsed = parse(await body.text(), { header: false });
  return parsed.data.slice(0, MAX_ROWS).map(row => ({
    url: String(row?.[0]||'').trim(),
    prefCat: String(row?.[1]||'').trim() || null
  })).filter(r => r.url);
}

function isGoodsUrl(u){ return /temu\.com\/goods\.html\?/.test(u); }
function getGoodsIdFromUrl(u){ const m=/goods_id=(\d{10,})/.exec(u); return m?m[1]:null; }

async function resolveWithBrowser(url,page){
  await page.route('**/*', r=>{
    const u=r.request().url();
    if(/install|app-redirect|umeng|byteoversea|gtm|analytics/.test(u)) return r.abort();
    r.continue();
  });
  await page.goto(url,{timeout:REDIRECT_TIMEOUT,waitUntil:'domcontentloaded'}).catch(()=>null);
  return await page.evaluate(()=>document.documentElement.innerHTML.match(/goods_id=(\d{10,})/)?.[1]||null);
}

async function extractProduct(goodsUrl,page){
  await page.goto(goodsUrl,{timeout:FETCH_TIMEOUT,waitUntil:'domcontentloaded'});
  await page.waitForTimeout(400);
  return await page.evaluate(() => {
    const title=document.querySelector('h1,[data-test-id="product-title"],title')?.textContent?.trim()||'';
    const price=document.querySelector('[data-test-id="price"],.price,.product-price')?.textContent?.replace(/[^0-9.,]/g,'')||'';
    const imgs=[...document.querySelectorAll('img[src*="media"]')].map(i=>i.src).slice(0,5);
    const html=document.documentElement.innerHTML.toLowerCase();
    const sold=/sold\s*out|out\s*of\s*stock|unavailable/.test(html);
    const hasBtn=!!document.querySelector('[data-test-id*="buy"],[data-test-id*="cart"]');
    const disabled=!!document.querySelector('button[disabled],button[aria-disabled="true"]');
    return { title, price, images: imgs, available: !sold && (hasBtn || !!price) && !disabled };
  });
}

function heuristicCategory(categories,title,pref){
  if(pref && categories.some(c=>c.slug===pref)) return pref;
  const t=title.toLowerCase();
  for(const c of categories){ if(c.keywords.some(k=>t.includes(k))) return c.slug; }
  return categories[0]?.slug||'room-decor';
}

function makeOutbound(id){ return `https://www.temu.com/goods.html?goods_id=${id}`; }

async function main(){
  await ensureDirs();
  const existing=(await readJSON(PRODUCTS_PATH))||[];
  const byId=new Map(existing.map(x=>[String(x.id),x]));
  const categories=(await readJSON(CATEGORIES_PATH))||[];
  const rows=await sheetRows();

  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({...MOBILE});
  const page=await ctx.newPage();

  const newTasks=rows.map(r=>(async()=>{
    let gid=isGoodsUrl(r.url)?getGoodsIdFromUrl(r.url):await resolveWithBrowser(r.url,page);
    if(!gid) return null;
    const meta=await extractProduct(makeOutbound(gid),page);
    const prev=byId.get(String(gid))||{};
    byId.set(String(gid),{
      id:String(gid),
      title:meta.title||prev.title||`Temu Item ${gid}`,
      slug:prev.slug||slugify(meta.title||`Temu Item ${gid}`,{lower:true,strict:true}),
      category:heuristicCategory(categories,meta.title||prev.title||'',r.prefCat),
      price:meta.price||prev.price||'',
      images:meta.images?.length?meta.images:prev.images||[],
      out_url:makeOutbound(gid),
      available:meta.available,
      added_at:prev.added_at||Date.now(),
      updated_at:Date.now(),
      checks:(prev.checks||0)+1
    });
  })());

  for(let i=0;i<newTasks.length;i+=CONCURRENCY){
    await Promise.all(newTasks.slice(i,i+CONCURRENCY));
  }

  // re-check части старых
  const rePool=[...byId.values()]
    .sort((a,b)=>(a.updated_at||0)-(b.updated_at||0))
    .slice(0,RECHECK_EXISTING);
  const reTasks=rePool.map(item=>(async()=>{
    try{
      const meta=await extractProduct(makeOutbound(item.id),page);
      byId.set(item.id,{
        ...item,
        title:meta.title||item.title,
        price:meta.price||item.price,
        images:meta.images?.length?meta.images:item.images,
        available:meta.available,
        updated_at:Date.now(),
        checks:(item.checks||0)+1
      });
    }catch{}
  })());
  for(let i=0;i<reTasks.length;i+=CONCURRENCY){
    await Promise.all(reTasks.slice(i,i+CONCURRENCY));
  }

  await browser.close();
  await writeJSON(PRODUCTS_PATH,[...byId.values()].sort((a,b)=>b.updated_at-a.updated_at));
  console.log(`[scrape] total ${byId.size}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
