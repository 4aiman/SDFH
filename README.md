Stella Deus Fuse Helper (SDFH)

Interactive CLI to browse items and compute fusion plans with cost analysis.

What’s included
- sdfh.js: single-file CLI
- sdfh_item_data.json: item database

Run
- node sdfh.js
- Or use the SEA executables in dist/ (no Node required)

Search examples
- katana r7
- battle axe
- battle axe r7
- golden apple r5 --full

What does r7 mean?
- r7 (or rank 7) is a rank filter. It limits matches to items of rank 7.
- With a type word (e.g., "katana r7"), it finds all items of that type and rank.
- With an exact item name + rank (e.g., "battle axe r7"), it searches within that item’s family/type.

Types vs item names
- You can search by type/category (e.g., "katana", "axe", "bow", "glove", "robe", etc.) to browse groups.
- You can search by exact item name (e.g., "Battle Axe").
- For rank filters:
  - Type + rank is required unless you give an exact full item name.
  - Examples:
    - OK: "axe r5" → all axes of rank 5
    - OK: "battle axe r5" → rank 5 items in the Battle Axe line/type
    - Not OK: "battle r5" (ambiguous; add a type or full name)

Partial and typos
- The search is typo-tolerant and token-aware. "bttle axe" or "btl ax" can still find "Battle Axe".
- Suggestions show the top matches; add --full to see more.

Fusion and pricing
- golden apple --fuse            Show default recipe’s fusion tree
- golden apple --fuse 2          Use recipe index 2
- golden apple --fuse --depth 3  Resolve to leaves with rank <= 3
- golden apple --fuse --store 3  Stop at purchasable leaves in store 3; show prices and total
- golden apple --fuse --depth 3 --store 3  Treat non-buyable leaves as owned; price the rest

Options
- --full                 Show up to 50 suggestions instead of 5
- --fuse [N]             Enter fusion mode; optional N is recipe index (1-based)
- --recipe [N]           Alias of --fuse [N]
- --depth N              Alias of --fuse-rank N; leaves must be rank <= N
- --fuse-rank N          Leaves must be rank <= N
- --store N              Price analysis at store level N (1..5)

Notes
- Types derive from guide sections; rank filters require explicit type or exact item name
- Data file is discovered beside the executable or in data/, then SEA-embedded asset

Platform notes
- macOS first run (ad‑hoc signing and quarantine removal):
  - For Apple Silicon use `sdfh-sea-macos-arm64`, for Intel use `sdfh-sea-macos-x64`.
  - Then run:
    ```bash
    xattr -p com.apple.quarantine ./sdfh-sea-macos-arm64 || true
    xattr -dr com.apple.quarantine ./sdfh-sea-macos-arm64
    codesign --force --sign - ./sdfh-sea-macos-arm64
    ```
  - If Finder blocks: System Settings → Privacy & Security → Allow Anyway, then Control‑click → Open.
- Windows on Wine: ensure Wine prefix reports Windows 10+ via winecfg so the exe launches by double‑click.

License
MIT

Acknowledgments
- Data and fusion references are derived from community guides on GameFAQs:
  - Dragen’s Fusion/Item FAQ: [link](https://gamefaqs.gamespot.com/ps2/921280-stella-deus-the-gate-of-eternity/faqs/36685)
  - Gundam4fun’s Fusion FAQ: [link](https://gamefaqs.gamespot.com/ps2/921280-stella-deus-the-gate-of-eternity/faqs/37029)
- While those guides are copyrighted, the factual data about in-game items and recipes is available to anyone who plays the game.
- Many thanks to the authors for their meticulous work collecting and presenting the data. This project acknowledges that processing the raw facts into a comprehensive, searchable format and building this fuse-helper app is a separate effort built on top of their contributions.


