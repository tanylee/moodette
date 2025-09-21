import 'dotenv/config';
import { chromium, devices } from 'playwright';
import Papa from 'papaparse';
import { request } from 'undici';
import fs from 'fs/promises';
import path from 'path';
import slugify from 'slugify';

const MOBILE = devices['iPhone 12'];
const SHEET_CSV_URL =
  process.env.SHEET_CSV_URL ||
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

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

async function ensureDirs(){ await fs.mkdir(path.dirname(PRODUCTS_PATH), { recursive: true }); }
async function readJSON(p){ try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
async function writeJSON(p, d){ await fs.writeFile(p, JSON.stringify(d, null, 2)); }

async function sheetRows(){
  const { body } = await request(SHEET_CSV_URL, { maxRedirections: 1 });
  const csv = await body.text();
  const parsed = Papa.parse(csv, { header: false, skipEmptyLines: true });
  return parsed.data
    .map(r => ({
      url: String(r?.[0] || '').trim(),
      prefCat: String(r?.[1] || '').trim() || null
    }))
    .filter(r => r.url)
    .slice(0, MAX_ROWS);
}

const goodsIdRe = /goods_id=(\d{10,})/i;
const isGoodsUrl = u => /temu\.com\/goods\.html\?/i.test(u);
const isShortTemu = u => /temu\.to\/k\//i.test(u);
const idFromUrl = u => {
  const m = goodsIdRe.exec(u);
  return m ? m[1] : null;
};
const makeGoodsUrl = id => `https://www.temu.com/goods.html?goods_id=${id}`;

/** Попытка №1: HTTP-запрос (без браузера): следуем редиректам и ищем goods_id в HTML */
async function resolveViaHTTP(url){
  try{
    const res = await request(url, {
      maxRedirections: 5,
      headers: {
        'user-agent': UA_MOBILE,
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    const text = await res.body.text();
    // Ищем goods_id в финальной странице/инлайновом JSON
    const m = text.match(goodsIdRe);
    return m ? m[1] : null;
  }catch{
    return null;
  }
}

/** Попытка №2: через браузер */
async function resolveViaBrowser(url, page){
  try{
    await page.route('**/*', r=>{
      const u=r.request().url();
      if(/install|app-redirect|umeng|byteoversea|gtm|analytics/i.test(u)) return r.abort();
      r.continue();
    });
    await page.goto(url, { timeout: REDIRECT_TIMEOUT, waitUntil: 'domcontentloaded' });
    const id = await page.evaluate(()=>{
      const html = document.documentElement.innerHTML;
      const m = html.match(/goods_id=(\d{10,})/i);
      return m ? m[1] : null;
    });
    return id;
  }catch{
    return null;
  }
}

async function extractProduct(goodsUrl,page){
  await page.goto(goodsUrl,{timeout:FETCH_TIMEOUT,waitUntil:'domcontentloaded'});
  await page.waitForTimeout(400);
  return await page.evaluate(() => {
    const title = document.querySelector('h1, [data-test-id="product-title"], title')?.textContent?.trim() || '';
    const price = document.querySelector('[data-test-id="price"], .price, .product-price')?.textContent?.replace(/[^0-9.,]/g,'') || '';
    const imgs = [...document.querySelectorAll('img[src*="media"]')].map(i=>i.src).slice(0,5);
    const html = document.documentElement.innerHTML.toLowerCase();
    const textHasSoldOut = /sold\s*out|out\s*of\s*stock|unavailable/.test(html);
    const hasBuyBtn = !!document.querySelector('[data-test-id*="buy"], [data-test-id*="cart"]');
    const disabledBtn = !!document.querySelector('button[disabled], button[aria-disabled="true"]');
    const available = !textHasSoldOut && (hasBuyBtn || !!price) && !disabledBtn;
    return { title, price, images: imgs, available };
  });
}

function heuristicCategory(categories,title, pref){
  if (pref && categories.some(c=>c.slug===pref)) return pref;
  const t=(title||'').toLowerCase();
  for (const c of categories){ if (c.keywords.some(k=>t.includes(k))) return c.slug; }
  return categories[0]?.slug || 'room-decor';
}

async function main(){
  await ensureDirs();
  const existing=(await readJSON(PRODUCTS_PATH))||[];
  const byId=new Map(existing.map(x=>[String(x.id),x]));
  const categories=(await readJSON(CATEGORIES_PATH))||[];
  const rows=await sheetRows();

  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({...MOBILE});
  const page=await ctx.newPage();

  let resolved = 0, addedOrUpdated = 0, failed = 0;

  const newTasks = rows.map(r => (async () => {
    try{
      let gid = null;

      // Прямая goods.html ?
      if (isGoodsUrl(r.url)) gid = idFromUrl(r.url);

      // Короткая temu.to/k/... — сначала HTTP, потом браузер
      if (!gid && isShortTemu(r.url)) gid = await resolveViaHTTP(r.url);
      if (!gid) gid = await resolveViaHTTP(r.url); // на всякий случай пробуем HTTP ещё раз и для любых ссылок
      if (!gid) gid = await resolveViaBrowser(r.url, page);

      if (!gid) { failed++; console.log(`[resolve] FAIL: ${r.url}`); return; }

      resolved++;
      const goodsUrl = makeGoodsUrl(gid);

      // Сохраняем партнёрскую короткую ссылку, если она была в листе
      const outUrl = isShortTemu(r.url) ? r.url : goodsUrl;

      const meta = await extractProduct(goodsUrl, page);
      const prev = byId.get(String(gid)) || {};
      const title = meta.title || prev.title || `Temu Item ${gid}`;

      byId.set(String(gid),{
        id:String(gid),
        title,
        slug: prev.slug || slugify(title, { lower: true, strict: true }),
        category: heuristicCategory(categories, title, r.prefCat),
        price: meta.price || prev.price || '',
        images: (meta.images && meta.images.length ? meta.images : prev.images) || [],
        out_url: outUrl,
        available: meta.available,
        added_at: prev.added_at || Date.now(),
        updated_at: Date.now(),
        checks: (prev.checks || 0) + 1
      });
      addedOrUpdated++;
      console.log(`[resolve] OK ${gid} ← ${r.url}`);
    }catch(e){
      failed++; console.log(`[resolve] ERROR for ${r.url}: ${e?.message||e}`);
    }
  })());

  for(let i=0;i<newTasks.length;i+=CONCURRENCY){
    await Promise.all(newTasks.slice(i,i+CONCURRENCY));
  }

  // частичный re-check старых
  const rePool=[...byId.values()].sort((a,b)=>(a.updated_at||0)-(b.updated_at||0)).slice(0,RECHECK_EXISTING);
  const reTasks=rePool.map(item=>(async()=>{
    try{
      const meta=await extractProduct(makeGoodsUrl(item.id),page);
      byId.set(item.id,{
        ...item,
        title:meta.title||item.title,
        price:meta.price||item.price,
        images:meta.images?.length?meta.images:item.images,
        available:meta.available,
        updated_at:Date.now(),
        checks:(item.checks||0)+1
      });
    }catch{/* skip */}
  })());
  for(let i=0;i<reTasks.length;i+=CONCURRENCY){ await Promise.all(reTasks.slice(i,i+CONCURRENCY)); }

  await browser.close();

  const final=[...byId.values()].sort((a,b)=>b.updated_at-a.updated_at);
  await writeJSON(PRODUCTS_PATH, final);

  console.log(`[scrape] rows in sheet: ${rows.length}`);
  console.log(`[scrape] resolved: ${resolved}, added/updated: ${addedOrUpdated}, failed: ${failed}`);
  console.log(`[scrape] total in JSON: ${final.length}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
