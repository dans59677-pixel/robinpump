/**
 * Unattended tier writer: spend whatever ETH is in the owner wallet, the moment
 * it arrives, on setTokenTiers() batches — never waiting for the full amount.
 *
 *   npm run auto:tiers                  # daemon: keep going until all ids are set
 *   AUTO_TIER_LIMIT=100 npm run auto:tiers   # this run stops after 100 ids
 *   AUTO_DRY_RUN=1 npm run auto:tiers   # print the plan, send nothing
 *   AUTO_ONCE=1 npm run auto:tiers      # one pass only, no waiting loop
 *
 * Why this exists
 * ---------------
 * setTokenTiers() is onlyOwner and costs gas. The owner wallet is topped up in
 * small amounts, so a single "write all 3333 ids" run would abort halfway with
 * an insufficient-funds error. This script instead:
 *
 *   1. reads the still-unwritten ids straight from the contract,
 *   2. prices ONE batch against the live gas price,
 *   3. sends only as many batches as the CURRENT balance can pay for,
 *   4. sleeps, re-reads the balance, and repeats.
 *
 * There is no local checkpoint file and nothing to resume by hand: the chain is
 * the only source of truth. Kill this process at any moment, on any machine, and
 * simply run it again — already-written ids are skipped because
 * unconfiguredTokenIds() no longer returns them.
 *
 * Scope note: this script FILLS GAPS. It writes ids that have no tier at all.
 * It deliberately does not rewrite an id whose on-chain tier disagrees with the
 * CSV — correcting a wrong tier is a decision, not a background job. Use
 * `npm run configure:tiers:csv` for that.
 *
 * It never calls lockRarity().
 */

import hre, { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import type { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
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

// ───────────────────────────────────────────────────────────────────────────────
// Tunables (all overridable from .env, all with safe defaults)
// ───────────────────────────────────────────────────────────────────────────────

/** How often to re-check the balance while waiting for a top-up. */
const POLL_SECONDS = readPositiveInt('AUTO_POLL_SECONDS', 60);
/** Breather between write transactions: the RPC throttles bursts. */
const BATCH_PAUSE_MS = 250;
/** Concurrent eth_call fan-out when reading the gap list. */
const GAP_QUERY_CHUNK = 200;
/** Gas headroom on top of estimateGas, as a percentage. */
const GAS_BUFFER_PERCENT = 25n;

const RATE_LIMITED = /too many requests|rate limit|rate-limit|429|-32005/i;
const NO_FUNDS = /insufficient funds|gas required exceeds|exceeds the balance|-32000.*funds/i;

function readPositiveInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    fail(`${name} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function readFlag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isRateLimit(err: unknown): boolean {
  return RATE_LIMITED.test(err instanceof Error ? err.message : String(err));
}

function isOutOfFunds(err: unknown): boolean {
  return NO_FUNDS.test(err instanceof Error ? err.message : String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry ONLY on rate-limit errors, with exponential backoff. A revert, a nonce
 * problem or a wrong signer is a real failure and must surface immediately
 * rather than being hammered against a live contract.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRateLimit(err)) throw err;
      const waitMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      console.log(`    rate limited on ${label}; retrying in ${waitMs} ms (${attempt}/${attempts - 1})`);
      await sleep(waitMs);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// CSV (same contract as configure-tiers-from-csv.ts: rarity is never guessed)
// ───────────────────────────────────────────────────────────────────────────────

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
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
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
    // Optional header row. "tokenId" is never a valid id, so this cannot mask data.
    if (/^tokenid$/i.test(idRaw)) return;

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

// ───────────────────────────────────────────────────────────────────────────────
// Chain reads
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Ids from the CSV that currently hold no tier at all, in ascending id order.
 * Uses the contract's own unconfiguredTokenIds() view — one eth_call per 200
 * ids instead of one per id, and free either way.
 */
async function readGapIds(staking: any, rows: ParsedRow[]): Promise<number[]> {
  const gaps: number[] = [];
  for (const group of chunk(rows.map(r => r.tokenId), GAP_QUERY_CHUNK)) {
    const missing: bigint[] = await withRetry(`unconfiguredTokenIds(${group.length})`, () =>
      staking.unconfiguredTokenIds(group)
    );
    for (const id of missing) gaps.push(Number(id));
  }
  return gaps.sort((a, b) => a - b);
}

/** Live gas price, whichever field this chain populates. */
async function currentGasPrice(): Promise<bigint> {
  const fee = await withRetry('getFeeData()', () => ethers.provider.getFeeData());
  const price = fee.gasPrice ?? fee.maxFeePerGas;
  if (price === null || price === undefined || price === 0n) {
    fail('The RPC returned no usable gas price (gasPrice and maxFeePerGas are both empty).');
  }
  return price;
}

function withBuffer(gas: bigint): bigint {
  return (gas * (100n + GAS_BUFFER_PERCENT)) / 100n;
}

// ───────────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  heading('Auto tier writer — spends incoming gas immediately');

  const dryRun = readFlag('AUTO_DRY_RUN');
  const oncePass = readFlag('AUTO_ONCE');
  const idLimit = Number((process.env.AUTO_TIER_LIMIT ?? '0').trim() || '0');
  if (!Number.isInteger(idLimit) || idLimit < 0) {
    fail(`AUTO_TIER_LIMIT must be 0 (no limit) or a positive integer, got "${process.env.AUTO_TIER_LIMIT}".`);
  }
  const batchSize = Math.min(readPositiveInt('AUTO_BATCH_SIZE', MAX_BATCH_SIZE), MAX_BATCH_SIZE);

  // A reserve is left untouched so the wallet is never scraped to exactly zero.
  // Default 0: the user explicitly asked for incoming ETH to be spent at once.
  const reserveRaw = (process.env.AUTO_GAS_RESERVE_ETH ?? '0').trim();
  let reserveWei: bigint;
  try {
    reserveWei = ethers.parseEther(reserveRaw === '' ? '0' : reserveRaw);
  } catch {
    fail(`AUTO_GAS_RESERVE_ETH is not a valid ETH amount: "${reserveRaw}"`);
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  const csvPath = path.resolve(ROOT_DIR, (process.env.TOKEN_TIERS_CSV ?? 'config/token-tiers.csv').trim());
  if (!fs.existsSync(csvPath)) {
    fail(`CSV not found: ${csvPath}\nPoint TOKEN_TIERS_CSV at your file, or create config/token-tiers.csv.`);
  }
  const rows = parseCsv(csvPath);
  const tierOf = new Map<number, number>(rows.map(r => [r.tokenId, r.tier]));

  step('Configuration');
  detail('csv', csvPath);
  detail('csv rows', `${rows.length} / ${TOTAL_SUPPLY}`);
  detail('batch size', batchSize);
  detail('id limit this run', idLimit === 0 ? 'none (until all ids are set)' : idLimit);
  detail('gas reserve kept', `${ethers.formatEther(reserveWei)} ETH`);
  detail('poll interval', `${POLL_SECONDS}s`);
  detail('mode', dryRun ? 'DRY RUN (nothing is sent)' : oncePass ? 'single pass' : 'daemon');

  // ── Target ─────────────────────────────────────────────────────────────────
  const chainId = await assertRobinhoodChain();
  const deployer = await getDeployer();
  const owner = await deployer.getAddress();
  const address = resolveStakingAddress(hre.network.name);
  await assertContractDeployed(address);
  const staking = await getStakingContract(address, deployer);

  step('Target');
  detail('chainId', chainId);
  detail('staking contract', address);
  detail('gas wallet (owner)', owner);

  const onChainOwner: string = await withRetry('owner()', () => staking.owner());
  if (onChainOwner.toLowerCase() !== owner.toLowerCase()) {
    fail(
      `This wallet is not the contract owner (${onChainOwner}). setTokenTiers() is onlyOwner ` +
        `and every transaction would revert.`
    );
  }
  if (await withRetry('rarityLocked()', () => staking.rarityLocked())) {
    fail('Rarity is already locked on this contract; tier writes are permanently disabled.');
  }

  // ── Work loop ──────────────────────────────────────────────────────────────
  let written = 0;
  let idleCycles = 0;

  for (;;) {
    const gaps = await readGapIds(staking, rows);
    const configured = Number(await withRetry('configuredCount()', () => staking.configuredCount()));

    if (gaps.length === 0) {
      step('Nothing left to write');
      detail('configuredCount', `${configured} / ${TOTAL_SUPPLY}`);
      console.log(
        configured === TOTAL_SUPPLY
          ? `\nEvery id in the collection now has a tier. lockRarity() is NOT run by this script.`
          : `\nEvery id present in the CSV has a tier. ${TOTAL_SUPPLY - configured} id(s) outside the CSV remain unset.`
      );
      return;
    }

    const budget = idLimit === 0 ? gaps.length : Math.max(0, idLimit - written);
    if (budget === 0) {
      step(`Reached AUTO_TIER_LIMIT=${idLimit} for this run`);
      detail('ids written', written);
      detail('configuredCount', `${configured} / ${TOTAL_SUPPLY}`);
      detail('still unwritten', gaps.length);
      console.log(`\nRun again (without AUTO_TIER_LIMIT) to continue with the remaining ${gaps.length} id(s).`);
      return;
    }

    const queue = gaps.slice(0, budget);
    const batches = chunk(queue, batchSize);

    step('Pending work');
    detail('configuredCount', `${configured} / ${TOTAL_SUPPLY}`);
    detail('unwritten ids', gaps.length);
    detail('queued this cycle', `${queue.length} id(s) in ${batches.length} batch(es)`);
    detail('id range queued', `${queue[0]}..${queue[queue.length - 1]}`);

    // Price one representative batch so the affordability check is real, not a guess.
    const sampleIds = batches[0];
    const sampleTiers = sampleIds.map(id => tierOf.get(id)!);
    const gasPrice = await currentGasPrice();
    const sampleGas = withBuffer(
      await withRetry('estimateGas(setTokenTiers)', () =>
        staking.setTokenTiers.estimateGas(sampleIds, sampleTiers)
      )
    );
    const costPerBatch = sampleGas * gasPrice;
    const balance = await withRetry('getBalance()', () => ethers.provider.getBalance(owner));
    const spendable = balance > reserveWei ? balance - reserveWei : 0n;
    const affordable = costPerBatch === 0n ? 0 : Number(spendable / costPerBatch);

    step('Gas check');
    detail('gas price', `${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
    detail('gas per batch (buffered)', sampleGas.toString());
    detail('cost per batch', `${ethers.formatEther(costPerBatch)} ETH`);
    detail('balance', `${ethers.formatEther(balance)} ETH`);
    detail('spendable now', `${ethers.formatEther(spendable)} ETH`);
    detail('batches affordable now', affordable);

    if (dryRun) {
      const reach = Math.min(affordable * batchSize, queue.length);
      console.log(
        `\nDRY RUN: would send ${Math.min(affordable, batches.length)} batch(es) covering ` +
          `${reach} id(s) and stop. Nothing was sent, no gas was spent.`
      );
      return;
    }

    if (affordable === 0) {
      const shortfall = costPerBatch > spendable ? costPerBatch - spendable : 0n;
      if (oncePass) {
        step('Not enough gas for even one batch');
        detail('short by', `${ethers.formatEther(shortfall)} ETH`);
        console.log(`\nSend any amount to ${owner} and run this again.`);
        return;
      }
      idleCycles++;
      console.log(
        `\n    waiting for gas: need ${ethers.formatEther(shortfall)} ETH more for the next batch. ` +
          `Re-checking ${owner} every ${POLL_SECONDS}s (idle cycle ${idleCycles}).`
      );
      await sleep(POLL_SECONDS * 1_000);
      continue;
    }

    idleCycles = 0;
    const plan = batches.slice(0, affordable);
    step(`Sending ${plan.length} setTokenTiers() transaction(s)`);

    for (let i = 0; i < plan.length; i++) {
      const ids = plan[i];
      const tiers = ids.map(id => tierOf.get(id)!);

      // Re-read the balance before each send: the price can move and the wallet
      // is shared with whatever else the owner does.
      const live = await withRetry('getBalance()', () => ethers.provider.getBalance(owner));
      if ((live > reserveWei ? live - reserveWei : 0n) < costPerBatch) {
        console.log(`    balance dropped below one batch; pausing here and re-checking.`);
        break;
      }

      let tx: ContractTransactionResponse;
      try {
        tx = await withRetry(`batch submit`, () => staking.setTokenTiers(ids, tiers));
      } catch (err) {
        if (isOutOfFunds(err)) {
          console.log(`    node rejected the batch for lack of funds; pausing here and re-checking.`);
          break;
        }
        throw err;
      }

      const receipt: ContractTransactionReceipt | null = await withRetry(`batch receipt`, () => tx.wait());
      if (!receipt || receipt.status !== 1) {
        fail(`setTokenTiers() reverted (tx ${tx.hash}). Nothing was written by it; re-run to resume.`);
      }

      written += ids.length;
      console.log(
        `    ids ${ids[0]}..${ids[ids.length - 1]}  (${ids.length})  ` +
          `written this run: ${written}  tx ${explorerTxUrl(tx.hash)}`
      );
      if (i + 1 < plan.length) await sleep(BATCH_PAUSE_MS);
    }

    if (oncePass) {
      const nowConfigured = Number(await withRetry('configuredCount()', () => staking.configuredCount()));
      step('Single pass finished');
      detail('ids written this run', written);
      detail('configuredCount', `${nowConfigured} / ${TOTAL_SUPPLY}`);
      return;
    }

    await sleep(BATCH_PAUSE_MS);
  }
}

runScript(main);
