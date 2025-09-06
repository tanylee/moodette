import fs from "fs/promises";
import Papa from "papaparse";
import { chromium, devices } from "playwright";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
if (!SHEET_CSV_URL) {
  console.error("Missing SHEET_CSV_URL env.");
  process.exit(1);
}

const OUT_PATH = new URL("../data/products.json", import.meta.url);

const MOBILE = devices["iPhone 12"];
const WAIT = (ms) => new Promise(r => setTimeout(r, ms));

function kwCategory(title = "") {
  const t = title.toLowerCase();
  if (/(candle|scent|soy|wax)/.test(t)) return "candles";
  if (/(organizer|storage|drawer|box|rack|hanger)/.test(t)) return "organizers";
  if (/(vase|decor|poster|frame|lamp|pillow|blanket|pastel|coquette|room)/.test(t)) return "room-decor";
  if (/(coat|sweater|dress|skirt|bag|outfit|cardigan)/.test(t)) return "pastel-fashion";
  if (/(dorm|college|study|desk)/.test(t)) return "dorm";
  return "mixed";
}

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse(text.trim(), { header: true });
  const rows = parsed.data
    .map(r => ({
      id: (r.id || "").toString().trim(),
      url: (r.affiliate_url || r.url || "").toString().trim(),
    }))
    .filter(r => r.id && r.url);
  // unique by id
  const map = new Map();
  for (const r of rows) if (!map.has(r.id)) map.set(r.id, r.url);
  return Array.from(map.entries()).map(([id,url]) => ({id,url}));
}

async function scrapeOne(page, id, affUrl) {
  const resp = await page.goto(affUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>null);
  if (!resp || !resp.ok()) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{});
  await WAIT(1200);

  const inBrowser = await page.locator('text=/Continue in browser|Continue in browser/i').first();
  if (await inBrowser.count()) {
    await inBrowser.click().catch(()=>{});
    await page.waitForLoadState("domcontentloaded").catch(()=>{});
    await WAIT(800);
  }

  const title =
    (await page.locator('meta[property="og:title"]').getAttribute("content").catch(()=>null)) ||
    (await page.locator('h1').first().textContent().catch(()=>null)) || "";

  const image =
    (await page.locator('meta[property="og:image"]').getAttribute("content").catch(()=>null)) ||
    (await page.locator('img[alt][src]').first().getAttribute("src").catch(()=>null)) || "";

  let price = "";
  const ldjsonHandles = await page.locator('script[type="application/ld+json"]').all();
  for (const h of ldjsonHandles) {
    try {
      const txt = await h.textContent();
      const data = JSON.parse(txt);
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        if ((n["@type"] || "").toLowerCase() === "product" && n.offers) {
          price = n.offers.price || n.offers.lowPrice || n.offers.highPrice || "";
          if (price) break;
        }
      }
      if (price) break;
    } catch {}
  }
  if (!price) {
    price = await page.locator('meta[itemprop="price"], meta[property="product:price:amount"]').getAttribute("content").catch(()=> "") || "";
  }
  if (price) {
    const num = parseFloat(String(price).replace(/[^\d.]/g,""));
    if (!Number.isNaN(num)) price = num.toFixed(2);
  }

  const category = kwCategory(title);

  return {
    id,
    title: title ? title.trim() : `Temu link — ${id}`,
    image: image || undefined,
    price: price || undefined,
    affiliate_url: affUrl,
    category
  };
}

async function run() {
  const rows = await fetchCsv(SHEET_CSV_URL);
  if (!rows.length) throw new Error("No rows in sheet CSV");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...MOBILE, locale: "en-US", timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();

  const out = [];
  for (const {id,url} of rows) {
    try {
      console.log("Scraping:", id, url);
      const item = await scrapeOne(page, id, url);
      out.push(item);
    } catch (e) {
      console.error("Failed:", id, url, e.message);
      out.push({ id, title: `Temu link — ${id}`, affiliate_url: url, category: "mixed" });
    }
  }

  await browser.close();
  if (out.length > 1) {
    out.sort((a,b) => ((b.image?1:0)+(b.price?1:0)) - ((a.image?1:0)+(a.price?1:0)));
  }
  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote", OUT_PATH.pathname);
}

run().catch(e => { console.error(e); process.exit(1); });
