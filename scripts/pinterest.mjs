import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd();
const PRODUCTS_PATH=path.join(ROOT,'public','data','products.json');
const CSV_PATH=path.join(ROOT,'data','pins.csv');
const PINS_PER_DAY=parseInt(process.env.PINS_PER_DAY||'100',10);

function esc(s){return '"' + String(s||'').replace(/"/g,'""') + '"';}

const all=JSON.parse(await fs.readFile(PRODUCTS_PATH,'utf8'));
const items=all.filter(x=>x.available!==false).slice(0,PINS_PER_DAY);

await fs.mkdir(path.dirname(CSV_PATH),{recursive:true});
const rows=[["board","title","description","link","image_url"]];
for(const it of items){
  rows.push([
    process.env.DEFAULT_BOARD||'Pastel Decor',
    it.pin_title||it.title,
    it.pin_desc||`Shop this ${it.category?.replace('-',' ')} find on Temu`,
    it.out_url,
    it.images?.[0]||''
  ]);
}
await fs.writeFile(CSV_PATH,rows.map(r=>r.map(esc).join(',')).join('\n'));
console.log(`[pins] wrote ${items.length}`);
