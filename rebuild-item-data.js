const fs = require('fs');
const path = require('path');

const INPUT_HTML = path.resolve('/home/chaiman/dev/ai/stella deus/Stella Deus_ The Gate of Eternity - Fusion FAQ - PlayStation 2 - By Gundam4fun - GameFAQs.html');
const OUTPUT_JSON = path.resolve('/home/chaiman/dev/ai/stella deus/sdfh_item_data.json');

function readHtml(file) {
  return fs.readFileSync(file, 'utf8');
}

function extractPre(html) {
  const preRegex = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  const pieces = [];
  let m;
  while ((m = preRegex.exec(html)) !== null) pieces.push(m[1]);
  if (pieces.length === 0) return html.replace(/<[^>]*>/g, '');
  return pieces.map((s) => s.replace(/<[^>]*>/g, '')).join('\n');
}

function buildGroupTypeMap(text) {
  const lines = text.split('\n');
  const groupTitleRe = /^\s*(\d+\.\d+)\s*-\s*(.+?)\s*$/;
  const mapTitleToType = (title) => {
    const t = String(title || '').toLowerCase();
    const words = t.split(/[^a-z0-9]+/).filter(Boolean);
    const hasWord = (w) => words.includes(w);
    const anyWord = (...ws) => ws.some((w) => hasWord(w));
    if (anyWord('katana','katanas')) return 'katana';
    if (anyWord('sword','swords')) return 'sword';
    if (anyWord('bow','bows')) return 'bow';
    if (anyWord('axe','axes')) return 'axe';
    if (anyWord('spear','spears')) return 'spear';
    if (anyWord('knife','knives')) return 'knife';
    if (anyWord('gauntlet','gauntlets','glove','gloves','mittens')) return 'glove';
    if (anyWord('shoe','shoes','boot','boots')) return 'shoe';
    if (anyWord('staff','staves','rod','rods','wand','wands')) return 'staff';
    if (anyWord('agryrion')) return 'agryrion';
    if (anyWord('helmet','helmets')) return 'helmet';
    if (anyWord('hat','hats')) return 'hat';
    if (anyWord('robe','robes')) return 'robe';
    if (anyWord('armor','armors','armour','mail','mails')) return 'armor';
    if (anyWord('shield','shields')) return 'shield';
    if (anyWord('ring','rings')) return 'ring';
    if (anyWord('amulet','amulets')) return 'amulet';
    if (anyWord('accessory','accessories')) return 'accessory';
    if (anyWord('scroll','scrolls')) return 'scroll';
    if (anyWord('class','change') || t.includes('rank up')) return 'rankup';
    if (anyWord('recovery')) return 'recovery';
    return undefined;
  };
  const groupToType = new Map();
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/\(\s*Rank\s*\d+\s*\)/i.test(line)) continue; // skip item headers
    const m = line.match(groupTitleRe);
    if (!m) continue;
    const group = m[1];
    const title = m[2];
    const type = mapTitleToType(title);
    if (type && !groupToType.has(group)) groupToType.set(group, type);
  }
  return groupToType;
}

function computeWeaponType(section) {
  // section: e.g., 1.6.8 → group 1.6
  const parts = section.split('.').map((x) => parseInt(x, 10));
  if (parts[0] !== 1) return undefined;
  const minor = parts[1];
  switch (minor) {
    case 1: return 'katana';
    case 2: return 'sword';
    case 3: return 'bow';
    case 4: return 'axe';
    case 5: return 'spear';
    case 6: return 'knife';
    case 7: return 'glove';
    case 8: return 'staff';
    case 9: return 'agryrion';
    default: return undefined;
  }
}

function computeNonWeaponType(section) {
  // Map other groups where the TOC defines a clear category
  // Example given: 5.2 - Scroll → all 5.2.* are scrolls
  const m = section.match(/^(\d+\.\d+)\./);
  if (!m) return undefined;
  const group = m[1];
  if (group === '5.2') return 'scroll';
  if (group === '4.2') return 'glove';     // Gauntlets
  if (group === '4.3') return 'shoe';      // Shoes
  if (group === '5.3') return 'rankup';    // Class change items
  return undefined;
}

function parseStatsLine(line) {
  const stats = {};
  const inner = line.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').trim();
  const parts = inner.split('/');
  for (const p of parts) {
    const m = p.trim().match(/([A-Z][A-Z0-9 ]+)\s+(-?\d+)/i);
    if (m) stats[m[1].trim()] = parseInt(m[2], 10);
  }
  return Object.keys(stats).length ? stats : null;
}

function parseGuide(text) {
  const lines = text.split('\n');
  const items = [];
  let current = null;
  let inStats = false;
  const headerRe = /^\s*(\d+\.\d+\.\d+)\s*-\s*(.+?)\s*\(\s*Rank\s*(\d+)\s*\)\s*(?:-\s*(.*))?$/i;
  const groupTypeMap = buildGroupTypeMap(text);
  // Manual additions for known groups if not present in titles
  if (!groupTypeMap.has('4.1')) groupTypeMap.set('4.1', 'shield'); // 4.1 - Shields (example)

  function push() {
    if (!current) return;
    if (!current.recipes) current.recipes = [];
    if (current.description && !current.description.trim()) delete current.description;
    if (current.stats && !Object.keys(current.stats).length) delete current.stats;
    items.push(current);
    current = null;
    inStats = false;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();

    const h = line.match(headerRe);
    if (h) {
      push();
      const section = h[1];
      const name = h[2].trim();
      const rank = parseInt(h[3], 10);
      const desc = (h[4] || '').trim();
      const groupKey = (section.match(/^(\d+\.\d+)\./) || [])[1];
      // Prefer hard-coded weapon mapping for 1.X, because TOC labels are inconsistent
      const isWeapon = /^1\./.test(section);
      const type = (isWeapon ? computeWeaponType(section) : (computeNonWeaponType(section) || groupTypeMap.get(groupKey))) || undefined;
      // Mark rank-up by description or by being in 5.3 group
      const rankUp = /rank\s*up\s*item/i.test(desc) || groupKey === '5.3' || type === 'rankup';
      const rankUpFor = [];
      const forMatch = desc.match(/for\s*:\s*([^]+)$/i);
      if (forMatch) {
        for (const part of forMatch[1].split(/[\/,]/)) {
          const t = part.trim();
          if (t) rankUpFor.push(t);
        }
      }
      current = { name, rank, description: desc || undefined, stats: undefined, recipes: [], type, rankUp: rankUp || undefined, rankUpFor: rankUpFor.length ? rankUpFor : undefined, section };
      continue;
    }

    if (!current) continue;

    if (/^[oO0\-=_]{5,}$/.test(line.replace(/\s+/g, ''))) { inStats = true; continue; }
    if (inStats && line.includes('|')) {
      const st = parseStatsLine(line);
      if (st) current.stats = { ...(current.stats || {}), ...st };
      continue;
    }
    if (inStats && line.trim() === '') { inStats = false; continue; }

    if (line.includes('+') && !line.includes('=')) {
      const parts = line.split('+');
      if (parts.length === 2) {
        const left = parts[0].trim();
        const right = parts[1].trim();
        if (/(\d+\.\d+\.\d+\s*-)/.test(left) || /(\d+\.\d+\.\d+\s*-)/.test(right)) continue;
        const rankM1 = left.match(/\(\s*R(?:ank)?\s*(\d+)\s*\)/i);
        const rankM2 = right.match(/\(\s*R(?:ank)?\s*(\d+)\s*\)/i);
        if (!rankM1 || !rankM2) continue;
        const name1 = left.replace(/\(\s*R(?:ank)?\s*\d+\s*\)/ig, '').trim();
        const name2 = right.replace(/\(\s*R(?:ank)?\s*\d+\s*\)/ig, '').trim();
        current.recipes.push({ ingredients: [ { name: name1, rank: parseInt(rankM1[1],10) }, { name: name2, rank: parseInt(rankM2[1],10) } ] });
      }
    }
  }
  push();

  // Post-fix: derive types for non-weapon items with heuristics only if missing
  const inferOther = (name) => {
    const n = (name || '').toLowerCase();
    const hasAny = (arr) => arr.some((w) => n.includes(w));
    if (hasAny(['helmet','hat','turban','mask','hachimaki','hachigane'])) return 'helmet';
    if (hasAny(['robe','garb','shawl'])) return 'robe';
    if (hasAny(['mail','armor','armour','plate'])) return 'armor';
    if (hasAny(['shield'])) return 'shield';
    if (hasAny(['ring','charm','amulet','talisman','anklet','earrings'])) return 'accessory';
    if (hasAny(['boots','shoes'])) return 'shoe';
    if (hasAny(['potion','elixir','antidote','holy water','whistle'])) return 'recovery';
    return undefined;
  };
  for (const it of items) {
    if (!it.type) {
      const t = inferOther(it.name);
      if (t) it.type = t;
    }
  }
  return items;
}

function main() {
  const html = readHtml(INPUT_HTML);
  const text = extractPre(html).replace(/\r\n/g, '\n');
  const items = parseGuide(text);
  const out = { items };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Rebuilt ${items.length} items → ${OUTPUT_JSON}`);
}

if (require.main === module) main();


