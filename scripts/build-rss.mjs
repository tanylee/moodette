import fs from 'fs/promises';

const SITE_URL = process.env.SITE_URL || 'https://capable-douhua-1a4c98.netlify.app';
const SRC  = new URL('../data/products.json', import.meta.url);
const DEST = new URL('../feed.xml', import.meta.url);

function esc(s=''){return s.replace(/[<>&'"]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[m]))}

const now = new Date().toUTCString();
const products = JSON.parse(await fs.readFile(SRC, 'utf8')).slice(0, 100);

const items = products.map(p=>{
  const title = esc(p.title || `Temu link — ${p.id}`);
  const target = p.affiliate_url && p.affiliate_url.startsWith('http')
    ? p.affiliate_url
    : (p.id ? `https://temu.to/k/${encodeURIComponent(p.id)}` : 'https://temu.to');
  // ведём через go.html?url=...
  const link  = `${SITE_URL}/go.html?url=${encodeURIComponent(target)}`;
  const guid  = esc(p.id || target);
  const desc  = esc(p.category || 'mixed');
  return `
  <item>
    <title>${title}</title>
    <link>${link}</link>
    <guid isPermaLink="false">${guid}</guid>
    <pubDate>${now}</pubDate>
    <description>${desc}</description>
  </item>`;
}).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Moodette feed</title>
<link>${SITE_URL}</link>
<description>New Temu finds</description>
<lastBuildDate>${now}</lastBuildDate>
${items}
</channel>
</rss>`;

await fs.writeFile(DEST, xml);
console.log('feed.xml written');
