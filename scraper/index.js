import fs from "fs/promises";
import Papa from "papaparse";
import { chromium, devices } from "playwright";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
if (!SHEET_CSV_URL) { console.error("Missing SHEET_CSV_URL"); process.exit(1); }

const OUT_PATH = new URL("../data/products.json", import.meta.url);

// ↑ таймауты и ретраи
const MOBILE = devices["iPhone 12"];
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "20", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "4", 10);
const REDIRECT_TIMEOUT = 15000;   // было 8000
const FETCH_TIMEOUT = 20000;      // было 12000
const RETRIES = 3;
const BACKOFF = ms => new Promise(r=>setTimeout(r, ms));

function kwCategory(t = "") {
  t = t.toLowerCase();
  if (/(candle|scent|wax)/.test(t)) return "candles";
  if (/(organizer|storage|drawer|rack|hanger|box)/.test(t)) return "organizers";
  if (/(vase|decor|frame|lamp|pillow|blanket|coquette|pastel)/.test(t)) return "room-decor";
  if (/(coat|sweater|dress|skirt|bag|cardigan|outfit)/.test(t)) return "pastel-fashion";
  if (/(dorm|college|study|desk)/.test(t)) return "dorm";
  return "mixed";
}

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse(text.trim(), { header: true });
  const rows = parsed.data
    .map(r => ({ id: (r.id||"").trim(), url: (r.affiliate_url||r.url||"").trim() }))
    .filter(r => r.id && r.url);
  const seen = new Set(), list = [];
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); list.push(r); }
  console.log(`Loaded ${list.length} rows, taking first ${Math.min(list.length, MAX_ROWS)}.`);
  return list.slice(0, MAX_ROWS);
}

async function resolveFinalUrl(ctx, affUrl) {
  let lastError;
  for (let i=0; i<RETRIES; i++) {
    const page = await ctx.newPage();
    await page.route("**/*", route => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return route.abort();
      route.continue();
    });
    try {
      await page.goto(affUrl, { waitUntil: "domcontentloaded", timeout: REDIRECT_TIMEOUT });
      await page.waitForURL(/temu\.com\/.*\.html/i, { timeout: REDIRECT_TIMEOUT });
      const url = page.url();
      await page.close().catch(()=>{});
      if (url) return url;
    } catch (e) {
      lastError = e;
    } finally {
      await page.close().catch(()=>{});
    }
    await BACKOFF(1000 * (i+1));
  }
  console.warn("resolveFinalUrl failed:", lastError?.message);
  return "";
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  } finally { clearTimeout(id); }
}

function firstMatch(html, regexps) {
  for (const re of regexps) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function extractMeta(html) {
  if (!html) return {};

  // ld+json (schema.org)
  let ld = firstMatch(html, [/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i]);
  let ldObj = null;
  try { if (ld) ldObj = JSON.parse(ld); } catch {}

  let title =
    firstMatch(html, [/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i]) ||
    (ldObj && (ldObj.name || (ldObj.product && ldObj.product.name))) ||
    firstMatch(html, [/<title>([^<]+)<\/title>/i]);

  let image =
    firstMatch(html, [/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i]) ||
    (ldObj && (ldObj.image?.url || (Array.isArray(ldObj.image) ? ldObj.image[0] : ldObj.image)));

  let price =
    firstMatch(html, [
      /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i,
      /"price"\s*:\s*"([^"]+)"/i,
      /"salePrice"\s*:\s*"([^"]+)"/i,
      /"current_price"\s*:\s*"([^"]+)"/i,
      /"minPrice"\s*:\s*"([^"]+)"/i,
      /"maxPrice"\s*:\s*"([^"]+)"/i,
      /"skuPrice"\s*:\s*"([^"]+)"/i
    ]) ||
    (ldObj && (ldObj.offers?.price || (Array.isArray(ldObj.offers) ? ldObj.offers[0]?.price : undefined)));

  if (price) {
    const num = parseFloat(String(price).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(num) && Number.isFinite(num)) price = num.toFixed(2);
    else price = "";
  }

  return { title, image, price };
}

async function scrapeOne(ctx, id, affUrl) {
  let finalUrl = "";
  let html = "";
  for (let i=0; i<RETRIES; i++) {
    if (!finalUrl) finalUrl = await resolveFinalUrl(ctx, affUrl);
    if (finalUrl && !html) html = await fetchWithTimeout(finalUrl, FETCH_TIMEOUT);
    const { title, image, price } = extractMeta(html);
    if (title || image) {
      return {
        id,
        title: title || `Temu link — ${id}`,
        image: image || undefined,
        price: price || undefined,
        affiliate_url: affUrl,
        category: kwCategory(title||"")
      };
    }
    await BACKOFF(1200 * (i+1)); // экспоненциальная задержка
  }
  // Фоллбек: карточка без данных, но ссылка рабочая
  return { id, title:`Temu link — ${id}`, affiliate_url: affUrl, category:"mixed" };
}

async function run(){
  let prev = []; try { prev = JSON.parse(await fs.readFile(OUT_PATH, "utf8")); } catch {}
  const prevMap = new Map(prev.map(p=>[p.id,p]));
  const rows = await fetchCsv(SHEET_CSV_URL);
  if (!rows.length) throw new Error("No rows in sheet CSV");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...MOBILE, locale: "en-US" });

  const q = rows.slice(); const results = [];
  async function worker(i){
    while(q.length){
      const {id,url} = q.shift();
      try{
        console.log(`[w${i}] ${results.length+1}/${rows.length} ${id}`);
        const item = await scrapeOne(context, id, url);
        results.push(item);
      }catch(e){
        console.error(`[w${i}] FAIL ${id}: ${e.message}`);
        results.push({ id, title:`Temu link — ${id}`, affiliate_url:url, category:'mixed' });
      }
      await BACKOFF(150);
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, (_,i)=>worker(i+1)));
  await browser.close();

  for (const r of results) prevMap.set(r.id, { ...(prevMap.get(r.id)||{}), ...r });
  const out = Array.from(prevMap.values())
    .sort((a,b)=>((b.image?1:0)+(b.price?1:0))-((a.image?1:0)+(a.price?1:0)));

  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote", OUT_PATH.pathname, "items:", out.length);
}

run().catch(e=>{ console.error(e); process.exit(1); });
