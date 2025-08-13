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

// ---------------- Fusion analysis ----------------

function parseFlags(input) {
  const flags = { recipeIndex: null, fuseRankLimit: null, full: false, doFuse: false, storeLevel: null };
  const parts = input.split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (/^--full$/i.test(p)) { flags.full = true; continue; }
    if (/^--fuse$/i.test(p)) { flags.doFuse = true; continue; }
    let m;
    m = p.match(/^--fuse=(\d+)$/i);
    if (m) { flags.doFuse = true; flags.recipeIndex = parseInt(m[1], 10); continue; }
    if (/^--fuse$/i.test(p) && parts[i + 1] && /^\d+$/.test(parts[i + 1])) { flags.doFuse = true; flags.recipeIndex = parseInt(parts[i + 1], 10); i += 1; continue; }
    m = p.match(/^--recipe=(\d+)$/i);
    if (m) { flags.doFuse = true; flags.recipeIndex = parseInt(m[1], 10); continue; }
    if (/^--recipe$/i.test(p) && parts[i + 1] && /^\d+$/.test(parts[i + 1])) { flags.doFuse = true; flags.recipeIndex = parseInt(parts[i + 1], 10); i += 1; continue; }
    let mTmp = p.match(/^--(?:fuse-rank)=(\d+)$/i);
    const mRank = (mTmp && mTmp[1]) || (p.match(/^--fuse-rank$/i) && parts[i + 1] && /^\d+$/.test(parts[i + 1]) ? parts[++i] : null);
    if (mRank) { flags.fuseRankLimit = parseInt(mRank, 10); continue; }
    mTmp = p.match(/^--(?:depth)=(\d+)$/i);
    const mDepthAsRank = (mTmp && mTmp[1]) || (p.match(/^--depth$/i) && parts[i + 1] && /^\d+$/.test(parts[i + 1]) ? parts[++i] : null);
    if (mDepthAsRank) { flags.fuseRankLimit = parseInt(mDepthAsRank, 10); continue; }
    mTmp = p.match(/^--store=(\d+)$/i);
    const mStore = (mTmp && mTmp[1]) || (p.match(/^--store$/i) && parts[i + 1] && /^\d+$/.test(parts[i + 1]) ? parts[++i] : null);
    if (mStore) { flags.storeLevel = Math.max(1, Math.min(5, parseInt(mStore, 10))); continue; }
    kept.push(p);
  }
  return { flags, remaining: kept.join(' ') };
}

function getItemsByTypeAndRank(index, type, rank) {
  const typeMap = index.typeRankMap.get(type);
  if (!typeMap) return [];
  return typeMap.get(rank) || [];
}

function getItemByExactName(index, name) {
  return index.nameMap.get(normalize(name)) || null;
}

function expandIngredient(index, ingredient, opts, visited) {
  if (opts && typeof opts.nodeBudget === 'number') {
    if (opts.nodeBudget <= 0) {
      return { name: ingredient.name, rank: ingredient.rank, leaf: true, truncated: true, children: [] };
    }
    opts.nodeBudget -= 1;
  }
  const node = { name: ingredient.name, rank: ingredient.rank, children: [] };
  if (opts.fuseRankLimit != null && ingredient.rank <= opts.fuseRankLimit) {
    node.leaf = true;
    return node;
  }
  const childItem = getItemByExactName(index, ingredient.name);
  if (!childItem) {
    node.leaf = true;
    node.missing = true;
    return node;
  }
  // If store level provided and this ingredient is purchasable at that store, stop here
  if (opts.storeLevel != null) {
    const priceInfo = getPriceAtStore(childItem, opts.storeLevel);
    if (priceInfo.purchasable) {
      node.leaf = true;
      return node;
    }
  }
  const key = `${childItem.name}|${childItem.rank}`;
  if (visited.has(key)) {
    node.leaf = true;
    node.cycle = true;
    return node;
  }
  visited.add(key);
  const recipes = Array.isArray(childItem.recipes) ? childItem.recipes : [];
  // If fuseRankLimit given, try to find any recipe that fully resolves to base items within limit
  if (opts.fuseRankLimit != null) {
    const ordered = sortRecipes(recipes);
    for (const r of ordered) {
      const left = expandIngredient(index, r.ingredients[0], opts, new Set(visited));
      const right = expandIngredient(index, r.ingredients[1], opts, new Set(visited));
      const ok = checkAllLeavesWithinRank([left, right], opts.fuseRankLimit);
      if (ok) {
        node.children.push(left, right);
        node.recipe = { ingredients: r.ingredients };
        visited.delete(key);
        return node;
      }
    }
    // fallback: just take first recipe one level
    if (recipes[0]) {
      const left = expandIngredient(index, recipes[0].ingredients[0], opts, new Set(visited));
      const right = expandIngredient(index, recipes[0].ingredients[1], opts, new Set(visited));
      node.children.push(left, right);
      node.recipe = { ingredients: recipes[0].ingredients };
    } else {
      node.leaf = true;
    }
    visited.delete(key);
    return node;
  }
  // If storeLevel given (and no fuseRankLimit), try to find any recipe that resolves to purchasable leaves
  if (opts.storeLevel != null) {
    const ordered = sortRecipes(recipes);
    for (const r of ordered) {
      const left = expandIngredient(index, r.ingredients[0], opts, new Set(visited));
      const right = expandIngredient(index, r.ingredients[1], opts, new Set(visited));
      const ok = checkAllLeavesPurchasable([left, right], index, opts.storeLevel);
      if (ok) {
        node.children.push(left, right);
        node.recipe = { ingredients: r.ingredients };
        visited.delete(key);
        return node;
      }
    }
    // fallback: first recipe
    if (recipes[0]) {
      const left = expandIngredient(index, recipes[0].ingredients[0], opts, new Set(visited));
      const right = expandIngredient(index, recipes[0].ingredients[1], opts, new Set(visited));
      node.children.push(left, right);
      node.recipe = { ingredients: recipes[0].ingredients };
    } else {
      node.leaf = true;
    }
    visited.delete(key);
    return node;
  }
  // depth-limited expansion (one level per call)
  if (recipes[0]) {
    const left = expandIngredient(index, recipes[0].ingredients[0], opts, new Set(visited));
    const right = expandIngredient(index, recipes[0].ingredients[1], opts, new Set(visited));
    node.children.push(left, right);
    node.recipe = { ingredients: recipes[0].ingredients };
  } else {
    node.leaf = true;
  }
  visited.delete(key);
  return node;
}

function checkAllLeavesWithinRank(nodes, limit) {
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop();
    if (n.children && n.children.length) stack.push(...n.children);
    else if (n.rank > limit) return false;
  }
  return true;
}

function checkAllLeavesPurchasable(nodes, index, storeLevel) {
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop();
    if (n.children && n.children.length) {
      stack.push(...n.children);
    } else {
      const it = getItemByExactName(index, n.name);
      const info = getPriceAtStore(it, storeLevel);
      if (!info.purchasable) return false;
    }
  }
  return true;
}

function printFusionTree(node, indent = '') {
  if (!node) return [];
  const lines = [];
  const isEnd = (!node.children || node.children.length === 0) && !node.missing && !node.cycle;
  const label = `${node.name} (R${node.rank})` + (node.missing ? ' [missing]' : node.cycle ? ' [cycle]' : isEnd ? ' [END]' : '');
  lines.push(indent + label);
  if (node.children && node.children.length) {
    const ing = node.recipe ? node.recipe.ingredients.map((i) => `${i.name} (R${i.rank})`).join(' + ') : '';
    if (ing) lines.push(indent + '  = ' + ing);
    for (const child of node.children) {
      lines.push(...printFusionTree(child, indent + '  '));
    }
  }
  return lines;
}

function collectLeaves(node, out) {
  if (!node) return;
  if (node.children && node.children.length) {
    for (const c of node.children) collectLeaves(c, out);
  } else {
    if (!node.missing && !node.cycle) out.push({ name: node.name, rank: node.rank });
  }
}

function printTotalsTable(leaves) {
  const map = new Map();
  for (const l of leaves) {
    const key = `${l.name}|${l.rank}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  const rows = Array.from(map.entries()).map(([key, count]) => {
    const [name, rankStr] = key.split('|');
    return { count, name, rank: parseInt(rankStr, 10) };
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const h1 = 'Count', h2 = 'Item', h3 = 'Rank';
  const w1 = Math.max(h1.length, ...rows.map(r => String(r.count).length), 1);
  const w2 = Math.max(h2.length, ...rows.map(r => r.name.length), 4);
  const w3 = Math.max(h3.length, ...rows.map(r => String(r.rank).length), 4);
  const hr = `+${'-'.repeat(w1 + 2)}+${'-'.repeat(w2 + 2)}+${'-'.repeat(w3 + 2)}+`;
  const header = `| ${h1.padEnd(w1)} | ${h2.padEnd(w2)} | ${h3.padEnd(w3)} |`;
  const lines = [];
  lines.push(hr);
  lines.push(header);
  lines.push(hr);
  for (const r of rows) {
    lines.push(`| ${String(r.count).padEnd(w1)} | ${r.name.padEnd(w2)} | ${String(r.rank).padEnd(w3)} |`);
  }
  lines.push(hr);
  return lines;
}

function getPriceAtStore(item, storeLevel) {
  if (!item || storeLevel == null) return { purchasable: false, price: null };
  const p = item.price;
  if (p == null) return { purchasable: false, price: null };
  if (typeof p === 'number') return { purchasable: true, price: p };
  if (Array.isArray(p)) {
    let last = null;
    for (let s = 1; s <= storeLevel; s += 1) {
      const idx = s - 1;
      if (idx < p.length) {
        const v = p[idx];
        if (v != null) last = v;
      }
    }
    if (last != null) return { purchasable: true, price: last };
  }
  return { purchasable: false, price: null };
}

function buildTotalsRowsWithPrice(leaves, index, storeLevel) {
  const countMap = new Map();
  for (const l of leaves) {
    const key = `${l.name}|${l.rank}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }
  const rows = [];
  for (const [key, count] of countMap.entries()) {
    const [name, rankStr] = key.split('|');
    const item = getItemByExactName(index, name);
    let unit = null;
    let purch = false;
    if (storeLevel != null) {
      const res = getPriceAtStore(item, storeLevel);
      unit = res.price;
      purch = res.purchasable;
    }
    rows.push({ count, name, rank: parseInt(rankStr, 10), price: unit, purchasable: purch });
  }
  rows.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return rows;
}

function printTotalsTableWithPrice(rows, fuseRankLimit) {
  const h1 = 'Count', h2 = 'Item', h3 = 'Rank', h4 = 'Price';
  const w1 = Math.max(h1.length, ...rows.map(r => String(r.count).length), 1);
  const w2 = Math.max(h2.length, ...rows.map(r => r.name.length), 4);
  const w3 = Math.max(h3.length, ...rows.map(r => String(r.rank).length), 4);
  const priceStrs = rows.map(r => (r.price != null ? String(r.price) : '-'));
  const w4 = Math.max(h4.length, ...priceStrs.map(s => s.length), 5);
  const hr = `+${'-'.repeat(w1 + 2)}+${'-'.repeat(w2 + 2)}+${'-'.repeat(w3 + 2)}+${'-'.repeat(w4 + 2)}+`;
  const header = `| ${h1.padEnd(w1)} | ${h2.padEnd(w2)} | ${h3.padEnd(w3)} | ${h4.padEnd(w4)} |`;
  const lines = [];
  lines.push(hr);
  lines.push(header);
  lines.push(hr);
  let total = 0;
  for (const r of rows) {
    const priceDisplay = r.price != null ? String(r.price) : '-';
    lines.push(`| ${String(r.count).padEnd(w1)} | ${r.name.padEnd(w2)} | ${String(r.rank).padEnd(w3)} | ${priceDisplay.padEnd(w4)} |`);
    if (r.price != null) total += r.count * r.price;
    else if (fuseRankLimit != null) total += 0; // treat as owned when depth/leaf rank is specified
  }
  lines.push(hr);
  const footerLabel = 'Total price';
  const footer = `| ${''.padEnd(w1)} | ${footerLabel.padEnd(w2)} | ${''.padEnd(w3)} | ${String(total).padEnd(w4)} |`;
  lines.push(footer);
  lines.push(hr);
  return lines;
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
    const sorted = sortRecipes(item.recipes);
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

function sortRecipes(recipes) {
  return [...(recipes || [])].sort((a, b) => {
    const ia = (a.ingredients || []);
    const ib = (b.ingredients || []);
    const ra = ia.map((x) => x && x.rank ? x.rank : 0);
    const rb = ib.map((x) => x && x.rank ? x.rank : 0);
    const maxA = Math.max(...ra, 0);
    const maxB = Math.max(...rb, 0);
    if (maxA !== maxB) return maxA - maxB;
    const sumA = ra.reduce((p, c) => p + c, 0);
    const sumB = rb.reduce((p, c) => p + c, 0);
    if (sumA !== sumB) return sumA - sumB;
    const aStr = `${(ia[0] && ia[0].name) ? ia[0].name : ''} + ${(ia[1] && ia[1].name) ? ia[1].name : ''}`;
    const bStr = `${(ib[0] && ib[0].name) ? ib[0].name : ''} + ${(ib[1] && ib[1].name) ? ib[1].name : ''}`;
    return aStr.localeCompare(bStr);
  });
}

// ---------------- CLI ----------------

function loadDataAuto() {
  function tryReadJSON(p) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(txt);
      if (obj && Array.isArray(obj.items)) return { items: obj.items.map((it) => ({ ...it })), source: p };
    } catch (e) {}
    return null;
  }
  function tryReadSEAAsset(key) {
    try {
      const sea = require('node:sea');
      if (sea && typeof sea.isSea === 'function' && sea.isSea()) {
        const txt = sea.getAsset(key, 'utf8');
        if (txt) {
          const obj = JSON.parse(txt);
          if (obj && Array.isArray(obj.items)) return { items: obj.items.map((it) => ({ ...it })), source: 'embedded-asset' };
        }
      }
    } catch (e) {}
    return null;
  }
  const execDir = (process && process.execPath) ? path.dirname(process.execPath) : __dirname;
  const candidates = [
    path.resolve(execDir, 'sdfh_item_data.json'),
    path.resolve(execDir, 'data', 'sdfh_item_data.json'),
    path.resolve(__dirname, 'sdfh_item_data.json'),
    path.resolve(__dirname, 'data', 'sdfh_item_data.json'),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const found = tryReadJSON(candidates[i]);
    if (found) return found;
  }
  // Fallbacks: try SEA asset first, then bundled require
  const fromSEA = tryReadSEAAsset('sdfh_item_data.json');
  if (fromSEA) return fromSEA;
  try {
    const embedded = require('./sdfh_item_data.json');
    if (embedded && Array.isArray(embedded.items)) {
      return { items: embedded.items.map((it) => ({ ...it })), source: 'embedded-require' };
    }
  } catch (e) {}
  console.error('Data file not found: tried', candidates.join(', '));
  process.exit(1);
}

function printHelp() {
  console.log('Commands:');
  console.log('  help           Show this help');
  console.log('  quit / exit    Exit the app');
  console.log('  <query>        Search items by name (partial match, typo-tolerant)');
  console.log('');
  console.log('Filters:');
  console.log('  - Append rank: "r8" or "rank 8" or trailing number (e.g., "katana r7")');
  console.log('  - Exact item name: "battle axe"; name + rank: "battle axe r7"');
  console.log('');
  console.log('Options:');
  console.log('  --full                 Show up to 50 suggestions instead of top 5');
  console.log('  --fuse [N]             Enter fusion mode. Optional N selects recipe index (1-based)');
  console.log('  --recipe [N]           Same as --fuse [N]');
  console.log('  --depth N              Alias of --fuse-rank N; leaves must be rank <= N');
  console.log('  --fuse-rank N          Leaves must be rank <= N');
  console.log('  --store N              Price analysis at store level N (1..5).');
  console.log('                         With --store, totals table shows Price and Total price.');
  console.log('                         With --depth and --store, items without prices are treated as owned');
  console.log('');
  console.log('Examples:');
  console.log('  golden apple --fuse');
  console.log('  golden apple --fuse 2');
  console.log('  golden apple --fuse --depth 3');
  console.log('  golden apple --fuse --store 3');
  console.log('  golden apple --fuse --depth 3 --store 3');
}

function start() {
  const loaded = loadDataAuto();
  const items = loaded.items;
  const index = buildIndex(items);
  console.log(`Loaded ${items.length} items from ${path.basename(loaded && loaded.source ? loaded.source : 'sdfh_item_data.json')}`);
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

    // Flags for fusion analysis
    const { flags, remaining } = parseFlags(input);
    const showFull = flags.full;
    const queryOnly = remaining;
    const result = search(index, queryOnly, showFull ? 50 : 5);
    if (result.exact.length > 0) {
      const item = result.exact[0];
      if (flags.doFuse || flags.recipeIndex != null || flags.fuseRankLimit != null) {
        const recipes = sortRecipes(Array.isArray(item.recipes) ? item.recipes : []);
        const idx = Math.max(1, Math.min(flags.recipeIndex || 1, recipes.length)) - 1;
        const recipe = recipes[idx];
        if (!recipe) {
          console.log(summarizeItem(item));
        } else {
          const visited = new Set();
          const left = expandIngredient(index, recipe.ingredients[0], { fuseRankLimit: flags.fuseRankLimit, storeLevel: flags.storeLevel, nodeBudget: 5000 }, visited);
          const right = expandIngredient(index, recipe.ingredients[1], { fuseRankLimit: flags.fuseRankLimit, storeLevel: flags.storeLevel, nodeBudget: 5000 }, visited);
          console.log(`${item.name} (Rank ${item.rank})${item.type ? ` [${item.type}]` : ''}`);
          console.log(`Recipe ${idx + 1}: ${recipe.ingredients.map((i) => `${i.name} (R${i.rank})`).join(' + ')}`);
          const lines = [...printFusionTree(left), ...printFusionTree(right)];
          lines.forEach((l) => console.log(l));
          const leaves = [];
          collectLeaves(left, leaves);
          collectLeaves(right, leaves);
          if (leaves.length) {
            console.log('Totals:');
            if (flags.storeLevel != null) {
              const rows = buildTotalsRowsWithPrice(leaves, index, flags.storeLevel);
              printTotalsTableWithPrice(rows, flags.fuseRankLimit).forEach((l) => console.log(l));
            } else {
              printTotalsTable(leaves).forEach((l) => console.log(l));
            }
          }
        }
      } else {
        console.log(summarizeItem(item));
      }
    } else if (result.suggestions.length > 0) {
      if (result.suggestions.length === 1) {
        const item = result.suggestions[0].item;
        if (flags.doFuse || flags.recipeIndex != null || flags.fuseRankLimit != null) {
          // Fusion analysis on the picked item
          const recipes = sortRecipes(Array.isArray(item.recipes) ? item.recipes : []);
          const idx = Math.max(1, Math.min(flags.recipeIndex || 1, recipes.length)) - 1; // default to first recipe
          const recipe = recipes[idx];
          if (!recipe) {
            console.log(summarizeItem(item));
          } else {
            const visited = new Set();
            const left = expandIngredient(index, recipe.ingredients[0], { fuseRankLimit: flags.fuseRankLimit, storeLevel: flags.storeLevel, nodeBudget: 5000 }, visited);
            const right = expandIngredient(index, recipe.ingredients[1], { fuseRankLimit: flags.fuseRankLimit, storeLevel: flags.storeLevel, nodeBudget: 5000 }, visited);
            console.log(`${item.name} (Rank ${item.rank})${item.type ? ` [${item.type}]` : ''}`);
            console.log(`Recipe ${idx + 1}: ${recipe.ingredients.map((i) => `${i.name} (R${i.rank})`).join(' + ')}`);
            const lines = [...printFusionTree(left), ...printFusionTree(right)];
            lines.forEach((l) => console.log(l));
            const leaves = [];
            collectLeaves(left, leaves);
            collectLeaves(right, leaves);
            if (leaves.length) {
              console.log('Totals:');
              if (flags.storeLevel != null) {
                const rows = buildTotalsRowsWithPrice(leaves, index, flags.storeLevel);
                printTotalsTableWithPrice(rows, flags.fuseRankLimit).forEach((l) => console.log(l));
              } else {
                printTotalsTable(leaves).forEach((l) => console.log(l));
              }
            }
          }
        } else {
          console.log(summarizeItem(item));
        }
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


