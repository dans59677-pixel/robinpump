/**
 * generate-token-tiers.js — writes config/token-tiers.csv from Model A.
 *
 * OFFLINE ONLY. No RPC, no private key, no transaction. The output is a plain
 * CSV that `npm run configure:tiers:csv` reads later, so this step is fully
 * reviewable and re-runnable before anything touches the chain.
 *
 * Model A (approved): score(token) = sum over the 11 traits of
 * total / count(trait value). Tokens are ranked rarest-first and cut into the
 * five contract tiers using the 1:3:9:27:81 population ratio implied by the
 * deployed rewardPerDay table, so every tier emits a comparable amount per day.
 *
 * Determinism matters because rarity is locked permanently on-chain: ties are
 * broken by ascending tokenId, so the same inputs always produce byte-identical
 * output. Re-running this script can never silently reshuffle tiers.
 *
 * Usage: node scripts/generate-token-tiers.js
 * Writes: config/token-tiers.csv, config/token-tiers.report.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ROOT = path.resolve(REPO, '..', 'ROBINPUMP');
const CSV_IN = path.join(ROOT, 'metadata.raw.csv');
const TRAITS_IN = path.join(ROOT, 'traits.json');
const CSV_OUT = path.join(REPO, 'config', 'token-tiers.csv');
const REPORT_OUT = path.join(REPO, 'config', 'token-tiers.report.json');

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
// From deployments/robinhood.json — the deployed, immutable-in-spirit rate table.
const REWARD_BASIS = [1, 3, 9, 27, 81];
const REWARD_PER_DAY = [1000, 333.333333, 111.111111, 37.037037, 12.345679];

const EXPECTED_TOKENS = 3333;

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
  const lines = fs.readFileSync(CSV_IN, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
  const header = splitCsvLine(lines[0]);

  const traitCols = [];
  header.forEach((name, index) => {
    const match = /^attributes\[(.+)\]$/.exec(name.trim());
    if (match) traitCols.push({ index, trait: match[1] });
  });
  if (traitCols.length === 0) throw new Error('no attributes[...] columns in metadata.raw.csv');

  const idCol = header.findIndex(h => /^tokenid$/i.test(h.trim()));
  if (idCol === -1) throw new Error('metadata.raw.csv has no tokenID column');

  const tokens = lines.slice(1).map((line, i) => {
    const parts = splitCsvLine(line);
    const tokenId = Number(parts[idCol]);
    if (!Number.isInteger(tokenId) || tokenId < 1) {
      throw new Error(`row ${i + 2}: unusable tokenID "${parts[idCol]}"`);
    }
    const traits = {};
    for (const { index, trait } of traitCols) traits[trait] = (parts[index] || '').trim();
    return { tokenId, traits };
  });

  return { tokens, traitNames: traitCols.map(c => c.trait) };
}

function main() {
  const traitStats = JSON.parse(fs.readFileSync(TRAITS_IN, 'utf8'));
  const { tokens, traitNames } = loadTokens();
  const total = tokens.length;

  // Refuse to emit a partial mapping: lockRarity() reverts with RarityIncomplete()
  // unless all 3333 ids are set, and a wrong count here would waste real gas.
  if (total !== EXPECTED_TOKENS) {
    throw new Error(`expected ${EXPECTED_TOKENS} tokens, parsed ${total}`);
  }
  const ids = new Set(tokens.map(t => t.tokenId));
  if (ids.size !== total) throw new Error('duplicate tokenIds in metadata.raw.csv');
  for (let id = 1; id <= EXPECTED_TOKENS; id += 1) {
    if (!ids.has(id)) throw new Error(`tokenId ${id} missing from metadata.raw.csv`);
  }

  // Score every token. An unknown trait value is a hard error rather than a
  // silent zero, because a swallowed miss would permanently misprice an NFT.
  for (const token of tokens) {
    let score = 0;
    for (const trait of traitNames) {
      const value = token.traits[trait];
      const stat = traitStats[trait] && traitStats[trait][value];
      if (!stat || !stat.count) {
        throw new Error(`token ${token.tokenId}: trait "${trait}" = "${value}" not found in traits.json`);
      }
      score += total / stat.count;
    }
    token.score = score;
  }

  // Rarest first; ascending tokenId breaks ties so the output is reproducible.
  const ranked = [...tokens].sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);

  const weightSum = REWARD_BASIS.reduce((s, w) => s + w, 0);
  const sizes = REWARD_BASIS.map(w => Math.round((total * w) / weightSum));
  sizes[4] += total - sizes.reduce((s, n) => s + n, 0); // rounding drift -> Common

  const tierOf = new Map();
  const bands = [];
  let cursor = 0;
  for (let tier = 0; tier < TIER_NAMES.length; tier += 1) {
    const band = ranked.slice(cursor, cursor + sizes[tier]);
    cursor += sizes[tier];
    for (const token of band) tierOf.set(token.tokenId, tier);
    bands.push({
      tier,
      name: TIER_NAMES[tier],
      count: band.length,
      percentage: Number(((band.length / total) * 100).toFixed(4)),
      scoreMin: Number(band[band.length - 1].score.toFixed(6)),
      scoreMax: Number(band[0].score.toFixed(6)),
      rewardPerDay: REWARD_PER_DAY[tier],
      emissionPerDayIfAllStaked: Number((band.length * REWARD_PER_DAY[tier]).toFixed(6))
    });
  }
  if (tierOf.size !== total) throw new Error('internal: not every token was assigned a tier');

  // Emit in ascending tokenId order — easier to eyeball and to diff.
  const out = [
    '# RobinPump Green Flock -> tier mapping (GENERATED, do not hand-edit)',
    '#',
    '# Source   : ROBINPUMP/metadata.raw.csv + ROBINPUMP/traits.json',
    '# Generator: scripts/generate-token-tiers.js (Model A)',
    '# Model    : score = sum over 11 traits of 1/(trait value frequency),',
    '#            ranked rarest-first, cut by the 1:3:9:27:81 population ratio',
    '#            implied by the deployed rewardPerDay table.',
    '# Tiers    : 0=Legendary 1=Epic 2=Rare 3=Uncommon 4=Common',
    `# Bands    : ${bands.map(b => `${b.name} ${b.count}`).join(', ')}`,
    '#',
    '# Regenerate with: node scripts/generate-token-tiers.js',
    '# Per-token scores and band boundaries: config/token-tiers.report.json',
    'tokenId,tier'
  ];
  for (let id = 1; id <= EXPECTED_TOKENS; id += 1) out.push(`${id},${tierOf.get(id)}`);

  fs.writeFileSync(CSV_OUT, `${out.join('\n')}\n`, 'utf8');

  const report = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/generate-token-tiers.js',
    model: 'A: trait-frequency score, population 1:3:9:27:81',
    sources: {
      metadata: path.relative(REPO, CSV_IN).replace(/\\/g, '/'),
      traitStatistics: path.relative(REPO, TRAITS_IN).replace(/\\/g, '/')
    },
    tokenCount: total,
    traitNames,
    bands,
    totalEmissionPerDayIfAllStaked:
      Number(bands.reduce((s, b) => s + b.emissionPerDayIfAllStaked, 0).toFixed(6)),
    // The 40 rarest tokens, so the ranking can be sanity-checked by eye.
    rarest: ranked.slice(0, 40).map(t => ({
      tokenId: t.tokenId,
      tier: tierOf.get(t.tokenId),
      tierName: TIER_NAMES[tierOf.get(t.tokenId)],
      score: Number(t.score.toFixed(6)),
      traits: t.traits
    })),
    // The 10 most common, as the other end of the check.
    mostCommon: ranked.slice(-10).map(t => ({
      tokenId: t.tokenId,
      tier: tierOf.get(t.tokenId),
      tierName: TIER_NAMES[tierOf.get(t.tokenId)],
      score: Number(t.score.toFixed(6)),
      traits: t.traits
    }))
  };
  fs.writeFileSync(REPORT_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`wrote ${path.relative(REPO, CSV_OUT).replace(/\\/g, '/')} (${total} rows)`);
  console.log(`wrote ${path.relative(REPO, REPORT_OUT).replace(/\\/g, '/')}`);
  console.log('');
  for (const b of bands) {
    console.log(
      `  ${b.tier} ${b.name.padEnd(9)} ${String(b.count).padStart(5)}` +
      ` (${b.percentage.toFixed(2).padStart(5)}%)  score ${b.scoreMin.toFixed(2)}..${b.scoreMax.toFixed(2)}` +
      `  ${b.emissionPerDayIfAllStaked.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`
    );
  }
  console.log('');
  console.log(`  total emission if every NFT is staked: ` +
    `${report.totalEmissionPerDayIfAllStaked.toLocaleString('en-US', { maximumFractionDigits: 0 })} ROBINPUMP/day`);
  console.log('');
  console.log('Nothing was sent on-chain. Review the CSV, then run:');
  console.log('  npm run configure:tiers:csv');
}

main();
