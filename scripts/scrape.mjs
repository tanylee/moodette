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
  const parsed = Papa.parse(csv, { header: false, skipEmptyLines:
