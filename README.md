Stella Deus Fuse Helper (SDFH)

Interactive CLI to browse Stella Deus items and their fusion recipes using section-typed data.

What’s included
- sdfh.js: single-file CLI (pure JS)
- sdfh_item_data.json: supplied data (items include name, rank, section, type, optional stats, and recipes)

How to run
- node sdfh.js

How to search
- Type-only rank: "katana r7", "axe r6", "hat r3"
- Exact item name: "battle axe"
- Item name + rank: "battle axe r7", "golden apple r5"
- Suggestions: top 5 by default; add "--full" to show more

Rules
- Types come from guide sections (e.g., 1.6 knife, 4.2 glove, 5.2 scroll, 5.3 rankup)
- No aliasing or cross-type mapping
- Rank queries use explicit types or exact item names only

Output
- Shows item header, optional stats, and an aligned ASCII table of all fusion recipes that create the item

License
MIT


