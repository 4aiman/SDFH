#!/usr/bin/env node
// Stella Deus Fuse Helper (SDFH) - single-file CLI

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------- Core search utilities ----------------

function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalize(text).split(' ').filter(Boolean);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}

function osaDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) d[i][0] = i;
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function buildIndex(items) {
  const index = items.map((it, idx) => {
    const normalizedName = normalize(it.name || '');
    const tokens = tokenize(it.name || '');
    return { idx, item: it, normalizedName, tokens };
  });
  const typeRankMap = new Map();
  for (const it of items) {
    const type = (it.type || '').toLowerCase();
    if (!type) continue;
    if (!typeRankMap.has(type)) typeRankMap.set(type, new Map());
    const rankMap = typeRankMap.get(type);
    if (!rankMap.has(it.rank)) rankMap.set(it.rank, []);
    rankMap.get(it.rank).push(it);
  }
  index.typeRankMap = typeRankMap;
  // name -> item for quick lookup
  index.nameMap = new Map();
  for (const it of items) {
    index.nameMap.set(normalize(it.name || ''), it);
  }
  return index;
}

function parseRankQuery(raw) {
  const s = String(raw);
  let m = s.match(/\b(?:rank\s*(\d+)|r\s*(\d+))\b/i);
  if (m) return parseInt(m[1] || m[2], 10);
  m = s.trim().match(/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function scoreCandidate(entry, query, queryTokens) {
  const name = entry.normalizedName;
  if (name === query) return 1000;
  let score = 0;
  if (name.startsWith(query)) score += 400;
  if (name.includes(query)) score += 220;
  for (const qt of queryTokens) {
    for (const tok of entry.tokens) {
      if (tok.startsWith(qt)) score += 40;
      if (tok === qt) score += 60;
    }
  }
  if (query.length > 0) {
    const dist = Math.min(osaDistance(name, query), levenshtein(name, query));
    const maxLen = Math.max(name.length, query.length) || 1;
    const sim = 1 - dist / maxLen;
    score += Math.floor(sim * 220);
  }
  for (const qt of queryTokens) {
    let best = 9999;
    for (const tok of entry.tokens) {
      const d = Math.min(osaDistance(tok, qt), levenshtein(tok, qt));
      if (d < best) best = d;
    }
    if (best < 9999) {
      const maxLen = Math.max(qt.length, (entry.tokens[0] || '').length, 1);
      const sim = 1 - Math.min(best / maxLen, 1);
      score += Math.floor(sim * 120);
    }
  }
  return score;
}

function search(index, rawQuery, limit = 5) {
  const query = normalize(rawQuery);
  const queryTokens = tokenize(rawQuery);
  if (!query) return { exact: [], suggestions: [] };

  const requestedRank = parseRankQuery(rawQuery);
  const nameOnlyQuery = normalize(String(rawQuery).replace(/\b(?:rank\s*\d+|r\s*\d+)\b/ig, '').trim());
  const nameOnlyTokens = tokenize(String(rawQuery).replace(/\b(?:rank\s*\d+|r\s*\d+)\b/ig, ''));

  const typeBoost = (() => {
    const tokens = nameOnlyTokens.map((t) => t.toLowerCase());
    const knownTypes = new Set(Array.from(index.typeRankMap.keys()));
    // Exact token match to a known type
    for (const tok of tokens) {
      if (knownTypes.has(tok)) return tok;
    }
    // Fuzzy: pick the closest known type only if distance <= 2
    let best = null;
    let bestD = Infinity;
    for (const tok of tokens) {
      for (const t of knownTypes) {
        const d = Math.min(osaDistance(tok, t), levenshtein(tok, t));
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    return bestD <= 2 ? best : null;
  })();

  let inferredType = typeBoost;
  // Prefer full item name as family proxy when rank is specified (e.g., "battle axe r6")
  const proxyName = nameOnlyQuery;
  const proxyNorm = normalize(proxyName || '');
  const exactItEarly = proxyNorm ? index.nameMap.get(proxyNorm) : null;
  if (exactItEarly && requestedRank) {
    inferredType = (exactItEarly.type && exactItEarly.type.toLowerCase()) || inferredType;
  }
  // Do not infer type from partial name tokens when rank is present. Only use explicit type word or exact item name.

  // If exact item name found and rank asked, use that item's type only (no inference)
  if (!inferredType && exactItEarly && requestedRank) {
    inferredType = (exactItEarly.type && exactItEarly.type.toLowerCase()) || null;
  }

  if (requestedRank) {
    if (inferredType) {
      const pool = index.filter((e) => (e.item.type || '').toLowerCase() === inferredType && e.item.rank === requestedRank);
      const direct = pool.map((e) => ({ item: e.item, score: 999 }));
      if (direct.length > 0) return { exact: [], suggestions: direct.slice(0, limit) };
    }
    // Rank was requested but we couldn't determine a type from either an explicit type word
    // or an exact full item name. Do not guess across all items; report no matches.
    return { exact: [], suggestions: [] };
  }

  const exact = index
    .filter((e) => e.normalizedName === query)
    .map((e) => e.item)
    .filter((it) => (requestedRank ? it.rank === requestedRank : true));
  if (exact.length > 0) return { exact, suggestions: [] };

  const scored = index
    .map((e) => ({ e, s: scoreCandidate(e, nameOnlyQuery || query, nameOnlyTokens.length ? nameOnlyTokens : queryTokens) }))
    .map((x) => ({ item: x.e.item, score: x.s + (typeBoost && x.e.item.type === typeBoost ? 120 : 0) }))
    .filter((x) => (requestedRank ? x.item.rank === requestedRank : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { exact: [], suggestions: scored };
}

function summarizeItem(item) {
  const lines = [];
  const typeLabel = item.type ? ` [${item.type}]` : '';
  lines.push(`${item.name} (Rank ${item.rank})${typeLabel}`);
  const desc = item.description || '';
  const descHasRankUp = /rank\s*up\s*item/i.test(desc);
  if (desc) lines.push(desc);
  if (item.rankUp && !descHasRankUp) {
    if (item.rankUpFor && item.rankUpFor.length) lines.push(`Rank Up Item for: ${item.rankUpFor.join(' / ')}`);
    else lines.push('Rank Up Item');
  }
  if (item.stats && Object.keys(item.stats).length > 0) {
    const statPairs = Object.keys(item.stats)
      .sort()
      .map((k) => `${k}: ${item.stats[k]}`);
    lines.push(`Stats: ${statPairs.join(', ')}`);
  }
  const numRecipes = Array.isArray(item.recipes) ? item.recipes.length : 0;
  lines.push(`Recipes to create: ${numRecipes}`);
  if (numRecipes > 0) {
    const sorted = [...item.recipes].sort((a, b) => {
      const ra = (a.ingredients || []).map((x) => x.rank || 0);
      const rb = (b.ingredients || []).map((x) => x.rank || 0);
      const maxA = Math.max(...ra, 0);
      const maxB = Math.max(...rb, 0);
      if (maxA !== maxB) return maxA - maxB;
      const sumA = ra.reduce((p, c) => p + c, 0);
      const sumB = rb.reduce((p, c) => p + c, 0);
      if (sumA !== sumB) return sumA - sumB;
      const aStr = `${a.ingredients[0].name} + ${a.ingredients[1].name}`;
      const bStr = `${b.ingredients[0].name} + ${b.ingredients[1].name}`;
      return aStr.localeCompare(bStr);
    });
    const fmt = (ing) => `${ing.name}${ing.rank ? ` (R${ing.rank})` : ''}`;
    const col1 = 'Ingredient 1';
    const col2 = 'Ingredient 2';
    const rows = sorted.map((r, i) => [String(i + 1), fmt(r.ingredients[0]), fmt(r.ingredients[1])]);
    const w0 = Math.max(1, '#'.length, ...rows.map((r) => r[0].length));
    const w1 = Math.max(col1.length, ...rows.map((r) => r[1].length));
    const w2 = Math.max(col2.length, ...rows.map((r) => r[2].length));
    const hr = `+${'-'.repeat(w0 + 2)}+${'-'.repeat(w1 + 2)}+${'-'.repeat(w2 + 2)}+`;
    const header = `| ${'#'.padEnd(w0)} | ${col1.padEnd(w1)} | ${col2.padEnd(w2)} |`;
    lines.push(hr);
    lines.push(header);
    lines.push(hr);
    for (const r of rows) lines.push(`| ${r[0].padEnd(w0)} | ${r[1].padEnd(w1)} | ${r[2].padEnd(w2)} |`);
    lines.push(hr);
  }
  return lines.join('\n');
}

// ---------------- CLI ----------------

function loadData(dataFile) {
  if (!fs.existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  if (!raw || !Array.isArray(raw.items)) {
    console.error('Invalid data format: expected { items: [] }');
    process.exit(1);
  }
  const items = raw.items.map((it) => ({ ...it }));
  // Do not infer or override types here. Trust the data file.
  return items;
}

function printHelp() {
  console.log('Commands:');
  console.log('  help           Show this help');
  console.log('  quit / exit    Exit the app');
  console.log('  <query>        Search items by name (partial match, typo-tolerant)');
  console.log('  Filters: append "r8" or "rank 8" or trailing number to constrain rank; prefix type, e.g., "katana r7"');
  console.log('  --full         Show up to 50 suggestions instead of top 5');
}

function start() {
  const DATA_FILE = path.resolve(__dirname, 'sdfh_item_data.json');
  const items = loadData(DATA_FILE);
  const index = buildIndex(items);
  console.log(`Loaded ${items.length} items from ${path.basename(DATA_FILE)}`);
  console.log('Type a name to search (partial allowed). Type "help" for help.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    historySize: 1000,
    terminal: true,
  });
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.toLowerCase() === 'help') {
      printHelp();
      rl.prompt();
      return;
    }
    if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    const showFull = /\s--full\b/i.test(input);
    const queryOnly = input.replace(/\s--full\b/i, '').trim();
    const result = search(index, queryOnly, showFull ? 50 : 5);
    if (result.exact.length > 0) {
      console.log(summarizeItem(result.exact[0]));
    } else if (result.suggestions.length > 0) {
      if (result.suggestions.length === 1) {
        console.log(summarizeItem(result.suggestions[0].item));
      } else {
        console.log('No exact match. Did you mean:');
        result.suggestions.forEach((s, i) => {
          const t = s.item.type ? ` [${s.item.type}]` : '';
          console.log(`  ${i + 1}. ${s.item.name} (Rank ${s.item.rank})${t}`);
        });
        console.log('Enter full name to see details.');
      }
    } else {
      console.log('No matches.');
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('Bye.');
    process.exit(0);
  });
}

if (require.main === module) {
  start();
}


