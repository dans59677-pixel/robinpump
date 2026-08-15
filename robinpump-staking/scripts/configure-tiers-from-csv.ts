/**
 * Assign the rarity tier of every Green Flock token id from a CSV file.
 *
 *   npm run configure:tiers:csv
 *
 * Input: config/token-tiers.csv  (override with TOKEN_TIERS_CSV in .env)
 * Format: one "tokenId,tier" pair per line. See config/token-tiers.example.csv.
 *
 * Rarity is NEVER guessed. Any row with a missing, blank or unrecognised tier
 * aborts the whole run before a single transaction is sent, and the report tells
 * you exactly which lines to fix.
 *
 * The script batches setTokenTiers() in MAX_BATCH_SIZE chunks, skips ids whose
 * on-chain tier already matches, and is safe to re-run after an interruption.
 */

import hre from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_BATCH_SIZE,
  MAX_TOKEN_ID,
  MIN_TOKEN_ID,
  ROOT_DIR,
  TIER_COUNT,
  TIER_NAMES,
  TOTAL_SUPPLY,
  assertContractDeployed,
  assertRobinhoodChain,
  chunk,
  detail,
  explorerTxUrl,
  fail,
  getDeployer,
  getStakingContract,
  heading,
  resolveStakingAddress,
  runScript,
  step
} from './lib/common';

interface ParsedRow {
  tokenId: number;
  tier: number;
  line: number;
}

function parseTier(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;

  if (/^\d+$/.test(value)) {
    const num = Number(value);
    return num >= 0 && num < TIER_COUNT ? num : null;
  }

  const byName = TIER_NAMES.findIndex(name => name.toLowerCase() === value.toLowerCase());
  return byName === -1 ? null : byName;
}

function parseCsv(file: string): ParsedRow[] {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  const seen = new Map<number, number>();

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;

    const parts = line.split(',');
    if (parts.length < 2) {
      errors.push(`line ${lineNo}: expected "tokenId,tier", got "${line}"`);
      return;
    }

    const idRaw = parts[0].trim();
    // Skip an optional header row.
    if (lineNo <= 5 && /^tokenid$/i.test(idRaw)) return;

    if (!/^\d+$/.test(idRaw)) {
      errors.push(`line ${lineNo}: tokenId "${idRaw}" is not a non-negative integer`);
      return;
    }
    const tokenId = Number(idRaw);
    if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) {
      errors.push(`line ${lineNo}: tokenId ${tokenId} is outside [${MIN_TOKEN_ID}, ${MAX_TOKEN_ID}]`);
      return;
    }

    const tier = parseTier(parts[1]);
    if (tier === null) {
      errors.push(
        `line ${lineNo}: tokenId ${tokenId} has an unusable tier "${parts[1].trim()}". ` +
          `Use 0..4 or one of ${TIER_NAMES.join('/')}. Rarity is never guessed.`
      );
      return;
    }

    const previous = seen.get(tokenId);
    if (previous !== undefined) {
      errors.push(`line ${lineNo}: tokenId ${tokenId} already appeared on line ${previous}`);
      return;
    }
    seen.set(tokenId, lineNo);
    rows.push({ tokenId, tier, line: lineNo });
  });

  if (errors.length > 0) {
    const shown = errors.slice(0, 25).join('\n    ');
    const more = errors.length > 25 ? `\n    ... and ${errors.length - 25} more` : '';
    fail(`config CSV has ${errors.length} problem(s):\n    ${shown}${more}`);
  }

  return rows;
}

async function main(): Promise<void> {
  heading('Assign per-token rarity from CSV');

  const csvPath = path.resolve(
    ROOT_DIR,
    (process.env.TOKEN_TIERS_CSV ?? 'config/token-tiers.csv').trim()
  );
  if (!fs.existsSync(csvPath)) {
    fail(
      `CSV not found: ${csvPath}\n` +
        `Copy config/token-tiers.example.csv to config/token-tiers.csv and fill in all ` +
        `${TOTAL_SUPPLY} rows, or point TOKEN_TIERS_CSV at your file.`
    );
  }

  const rows = parseCsv(csvPath);

  step('CSV parsed');
  detail('file', csvPath);
  detail('valid rows', rows.length);
  const counts = TIER_NAMES.map((_, tier) => rows.filter(r => r.tier === tier).length);
  TIER_NAMES.forEach((name, tier) => detail(`  tier ${tier} ${name}`, counts[tier]));

  if (rows.length !== TOTAL_SUPPLY) {
    console.log(
      `\n    NOTE: the CSV covers ${rows.length} of ${TOTAL_SUPPLY} ids. ` +
        `lockRarity() will revert with RarityIncomplete() until all ${TOTAL_SUPPLY} are set.`
    );
  }

  const chainId = await assertRobinhoodChain();
  const deployer = await getDeployer();
  const deployerAddress = await deployer.getAddress();
  const address = resolveStakingAddress(hre.network.name);
  await assertContractDeployed(address);
  const staking = await getStakingContract(address, deployer);

  step('Target');
  detail('chainId', chainId);
  detail('staking contract', address);
  detail('caller', deployerAddress);

  const owner: string = await staking.owner();
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    fail(`Caller is not the owner (${owner}). setTokenTiers() is onlyOwner and would revert.`);
  }
  if (await staking.rarityLocked()) {
    fail('Rarity is already locked on this contract; tier writes are permanently disabled.');
  }

  // ── Skip ids that already hold the intended tier ──────────────────────────
  step('Checking which ids still need writing');
  const pending: ParsedRow[] = [];
  for (const group of chunk(rows, 200)) {
    const results = await Promise.all(
      group.map(async row => {
        const configured: boolean = await staking.isTierConfigured(row.tokenId);
        if (!configured) return row;
        const current = Number(await staking.tokenTier(row.tokenId));
        return current === row.tier ? null : row;
      })
    );
    for (const row of results) {
      if (row) pending.push(row);
    }
  }
  detail('already correct', rows.length - pending.length);
  detail('to write', pending.length);

  if (pending.length === 0) {
    step('Nothing to do — every id in the CSV already holds its configured tier.');
    return;
  }

  // ── Write in batches ──────────────────────────────────────────────────────
  const batches = chunk(pending, MAX_BATCH_SIZE);
  step(`Sending ${batches.length} setTokenTiers() transaction(s) of up to ${MAX_BATCH_SIZE} ids`);

  let sent = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const ids = batch.map(r => r.tokenId);
    const tiers = batch.map(r => r.tier);

    const tx = await staking.setTokenTiers(ids, tiers);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      fail(`Batch ${i + 1}/${batches.length} reverted (tx ${tx.hash}). Re-run to resume.`);
    }
    sent += batch.length;
    console.log(
      `    batch ${String(i + 1).padStart(String(batches.length).length)}/${batches.length}  ` +
        `ids ${ids[0]}..${ids[ids.length - 1]}  ${sent}/${pending.length} written  tx ${tx.hash}`
    );
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  step('Verifying on-chain state');
  const configuredCount = Number(await staking.configuredCount());
  detail('configuredCount', `${configuredCount} / ${TOTAL_SUPPLY}`);

  const sample = pending.slice(0, Math.min(pending.length, 10));
  for (const row of sample) {
    const onChain = Number(await staking.tokenTier(row.tokenId));
    if (onChain !== row.tier) {
      fail(`tokenId ${row.tokenId} reads tier ${onChain}, expected ${row.tier}.`);
    }
  }
  detail('sampled ids match', `${sample.length}/${sample.length}`);

  const tierCounts: bigint[] = [...(await staking.getTierCounts())];
  TIER_NAMES.forEach((name, tier) => detail(`on-chain tier ${tier} ${name}`, tierCounts[tier].toString()));

  if (configuredCount === TOTAL_SUPPLY) {
    console.log(
      `\nAll ${TOTAL_SUPPLY} ids are configured. Freeze rarity permanently with:\n` +
        `    npm run lock:rarity`
    );
  } else {
    console.log(
      `\n${TOTAL_SUPPLY - configuredCount} id(s) still have no tier. ` +
        `lockRarity() stays blocked until every id is set.`
    );
  }
}

runScript(main);
