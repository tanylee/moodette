# Moodette — Sheet-only flow

- Источник: Google Sheet с колонками `id, affiliate_url` (published as CSV).
- GitHub Action `scrape.yml` читает CSV и через Playwright тянет `title/image/price` — пишет `data/products.json`.
- Сайт берёт `data/products.json` и показывает карточки.

## Настройка
1) Sheet: `id,affiliate_url` → File → Share → Publish to the web → CSV link.
2) GitHub → Settings → Secrets → Actions → `SHEET_CSV_URL` = CSV link.
3) Actions → Run `Scrape Temu -> products.json`.
4) Pages деплоит сайт автоматически.
