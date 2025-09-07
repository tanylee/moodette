import fs from "fs/promises";
import Papa from "papaparse";
import { chromium, devices } from "playwright";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
if (!SHEET_CSV_URL) { console.error("Missing SHEET_CSV_URL"); process.exit(1); }

const OUT_PATH = new URL("../data/products.json", import.meta.url);

const MOBILE = devices["iPhone 12"];
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "4", 10);
const REDIRECT_TIMEOUT = 8000;
const FETCH_TIMEOUT = 12000;

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
  const sliced = list.slice(0, MAX_ROWS);
  console.log(`Loaded ${list.length} rows, taking first ${sliced.length}.`);
  return sliced;
}

async function resolveFinalUrl(ctx, affUrl) {
  const page = await ctx.newPage();
  await page.route("**/*", route => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return route.abort();
    route.continue();
  });
  let finalUrl = "";
  try {
    await page.goto(affUrl, { waitUntil: "domcontentloaded", timeout: REDIRECT_TIMEOUT }).catch(()=>{});
    await page.waitForURL(/temu\.com\/.*\.html/i, { timeout: REDIRECT_TIMEOUT }).catch(()=>{});
    finalUrl = page.url();
  } finally { await page.close().catch(()=>{}); }
  return finalUrl;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController(); const tid = setTimeout(()=>ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.text() : "";
  } catch { return ""; } finally { clearTimeout(tid); }
}

function extractMeta(html) {
  if (!html) return {};
  const pick = re => (html.match(re) || [,""])[1].trim();
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                pick(/<title>([^<]+)<\/title>/i);
  const image = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  let price = pick(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i) ||
              pick(/"price"\s*:\s*"([^"]+)"/i) ||
              pick(/"lowPrice"\s*:\s*"([^"]+)"/i);
  if (price) {
    const num = parseFloat(price.replace(/[^\d.]/g,""));
    if (!Number.isNaN(num)) price = num.toFixed(2);
  }
  return { title, image, price };
}

async function scrapeOne(ctx, id, affUrl) {
  const finalUrl = await resolveFinalUrl(ctx, affUrl);
  if (!finalUrl) return { id, title:`Temu link — ${id}`, affiliate_url: affUrl, category:"mixed" };
  const html = await fetchWithTimeout(finalUrl, FETCH_TIMEOUT);
  const { title, image, price } = extractMeta(html);
  return {
    id,
    title: title || `Temu link — ${id}`,
    image: image || undefined,
    price: price || undefined,
    affiliate_url: affUrl,
    category: kwCategory(title||"")
  };
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

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
      await sleep(120);
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
