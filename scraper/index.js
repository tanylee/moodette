import fs from "fs/promises";
import Papa from "papaparse";
import { chromium, devices } from "playwright";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
if (!SHEET_CSV_URL) {
  console.error("Missing SHEET_CSV_URL env.");
  process.exit(1);
}

const OUT_PATH = new URL("../data/products.json", import.meta.url);

// Параметры производительности
const MOBILE = devices["iPhone 12"];
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "20", 10);         // сколько ссылок обрабатываем за 1 прогон
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);   // параллельных браузерных вкладок
const PAGE_TIMEOUT = 45000;                                         // 45s на страницу
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
  const list = Array.from(map.entries()).map(([id, url]) => ({ id, url }));

  const sliced = list.slice(0, MAX_ROWS);
  console.log(`Loaded ${list.length} rows, taking first ${sliced.length}.`);
  return sliced;
}

async function scrapeOne(ctx, id, affUrl) {
  const page = await ctx.newPage();
  // Режем тяжёлые ресурсы — нам нужен лишь HTML/мета
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) return route.abort();
    route.continue();
  });
  page.setDefaultTimeout(PAGE_TIMEOUT);

  try {
    const resp = await page.goto(affUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    if (!resp || !resp.ok()) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }).catch(() => {});
    }
    // иногда появляется «Continue in browser»
    const inBrowser = page.locator('text=/Continue in browser|Открыть в браузере/i').first();
    if (await inBrowser.count()) {
      await inBrowser.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    // собираем данные
    const title =
      (await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null)) ||
      (await page.locator('h1').first().textContent().catch(() => null)) || "";

    const image =
      (await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null)) ||
      (await page.locator('img[alt][src]').first().getAttribute("src").catch(() => null)) || "";

    let price = "";
    const ldjsonHandles = await page.locator('script[type="application/ld+json"]').all();
    for (const h of ldjsonHandles) {
      try {
        const txt = await h.textContent();
        const data = JSON.parse(txt);
        const nodes = Arra
