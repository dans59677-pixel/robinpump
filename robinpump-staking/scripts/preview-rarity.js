/**
 * preview-rarity.js — READ ONLY. Writes nothing, sends nothing on-chain.
 *
 * The collection metadata carries NO tier/rarity field per token: metadata.raw.csv
 * has only the 11 cosmetic trait columns, and ROBINPUMP/traits.json records rarity
 * labels per TRAIT VALUE (not per token). So a per-token tier has to be derived.
 *
 * This script prints, side by side, what two candidate derivations would produce,
 * so the tier model can be chosen on numbers instead of assumption. Nothing here
 * decides anything — configure:tiers:csv still reads config/token-tiers.csv.
 *
 *   Model A — rarity score, fixed population.
 *     score(token) = sum over traits of 1 / (trait value frequency).
 *     Tokens are ranked by score and cut into the 5 tiers using the 1:3:9:27:81
 *     ratio implied by the deployed rewardPerDay table, so each band emits a
 *     comparable total per day.
 *
 *   Model B — rarest-trait label.
 *     A token inherits the label of its single rarest trait value, as recorded in
 *     traits.json. traits.json also uses a "Mythic" label the contract has no tier
 *     for (only 5 tiers exist), so Mythic folds into Legendary.
 *
 * Usage: node scripts/preview-rarity.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'ROBINPUMP');
const CSV = path.join(ROOT, 'metadata.raw.csv');
const TRAITS = path.join(ROOT, 'traits.json');

// Contract tier order is fixed: 0 = Legendary ... 4 = Common.
const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

// From the deployed rewardPerDay table (deployments/robinhood.json).
const REWARD_BASIS = [1, 3, 9, 27, 81];
const REWARD_PER_DAY = [1000, 333.333333, 111.111111, 37.037037, 12.345679];

/** Minimal RFC4180-ish splitter: handles quoted fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function loadTokens() {
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
  const header = splitCsvLine(lines[0]);

  // Trait columns are named attributes[Name]; everything else is descriptive.
  const traitCols = [];
  header.forEach((name, index) => {
    const match = /^attributes\[(.+)\]$/.exec(name.trim());
    if (match) traitCols.push({ index, trait: match[1] });
  });
  const idCol = header.findIndex(h => /^tokenid$/i.test(h.trim()));
  if (idCol === -1) throw new Error('metadata.raw.csv has no tokenID column');

  const tokens = lines.slice(1).map(line => {
    const parts = splitCsvLine(line);
    const traits = {};
    for (const { index, trait } of traitCols) traits[trait] = (parts[index] || '').trim();
    return { tokenId: Number(parts[idCol]), traits };
  });

  return { tokens, traitNames: traitCols.map(c => c.trait) };
}

function main() {
  const traitStats = JSON.parse(fs.readFileSync(TRAITS, 'utf8'));
  const { tokens, traitNames } = loadTokens();
  const total = tokens.length;

  console.log(`tokens parsed        : ${total}`);
  console.log(`trait columns        : ${traitNames.length} (${traitNames.join(', ')})`);
  const ids = new Set(tokens.map(t => t.tokenId));
  console.log(`tokenId range        : ${Math.min(...ids)}..${Math.max(...ids)}`);
  console.log(`duplicate tokenIds   : ${total - ids.size}`);
  console.log('');

  // ── Model A: rarity score over trait frequencies ──────────────────────────
  const missing = new Set();
  for (const token of tokens) {
    let score = 0;
    for (const trait of traitNames) {
      const value = token.traits[trait];
      const stat = traitStats[trait] && traitStats[trait][value];
      if (!stat) { missing.add(`${trait}=${value}`); continue; }
      // 1 / frequency. Uses count so the divisor is exact rather than rounded.
      score += total / stat.count;
    }
    token.score = score;
  }
  if (missing.size) {
    console.log(`WARNING: ${missing.size} trait values absent from traits.json:`);
    for (const key of [...missing].slice(0, 10)) console.log(`  - ${key}`);
    console.log('');
  }

  // Rank rarest first, then cut by the 1:3:9:27:81 population ratio.
  const ranked = [...tokens].sort((a, b) =>
    b.score - a.score || a.tokenId - b.tokenId);

  const weightSum = REWARD_BASIS.reduce((s, w) => s + w, 0);
  const sizes = REWARD_BASIS.map(w => Math.round((total * w) / weightSum));
  // Absorb the rounding drift into the largest (Common) band.
  sizes[4] += total - sizes.reduce((s, n) => s + n, 0);

  console.log('Model A — rarity score, population fixed at 1:3:9:27:81');
  let cursor = 0;
  let dailyA = 0;
  for (let tier = 0; tier < 5; tier += 1) {
    const band = ranked.slice(cursor, cursor + sizes[tier]);
    cursor += sizes[tier];
    const emission = band.length * REWARD_PER_DAY[tier];
    dailyA += emission;
    const pct = ((band.length / total) * 100).toFixed(2);
    console.log(
      `  ${tier} ${TIER_NAMES[tier].padEnd(9)} ${String(band.length).padStart(5)}` +
      ` (${pct.padStart(5)}%)  score ${band[band.length - 1].score.toFixed(2)}` +
      `..${band[0].score.toFixed(2)}  ${emission.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`
    );
  }
  console.log(`  total emission if every NFT is staked: ` +
    `${dailyA.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`);
  console.log('');

  // ── Model B: rarest trait label ───────────────────────────────────────────
  // Mythic has no contract tier, so it folds into Legendary.
  const LABEL_TO_TIER = {
    Mythic: 0, Legendary: 0, Epic: 1, Rare: 2, Uncommon: 3, Common: 4
  };
  const countsB = [0, 0, 0, 0, 0];
  for (const token of tokens) {
    let best = 4;
    for (const trait of traitNames) {
      const stat = traitStats[trait] && traitStats[trait][token.traits[trait]];
      if (!stat) continue;
      const tier = LABEL_TO_TIER[stat.rarity];
      if (tier !== undefined && tier < best) best = tier;
    }
    countsB[best] += 1;
  }

  console.log('Model B — token inherits its rarest trait label (Mythic -> Legendary)');
  let dailyB = 0;
  for (let tier = 0; tier < 5; tier += 1) {
    const emission = countsB[tier] * REWARD_PER_DAY[tier];
    dailyB += emission;
    const pct = ((countsB[tier] / total) * 100).toFixed(2);
    console.log(
      `  ${tier} ${TIER_NAMES[tier].padEnd(9)} ${String(countsB[tier]).padStart(5)}` +
      ` (${pct.padStart(5)}%)  ` +
      `${emission.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`
    );
  }
  console.log(`  total emission if every NFT is staked: ` +
    `${dailyB.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`);
}

main();
