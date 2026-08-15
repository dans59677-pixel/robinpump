/**
 * Shared helpers for every script in this project.
 *
 * Design rules enforced here:
 *  - Never run a mainnet action against the wrong chain: assertRobinhoodChain()
 *    aborts unless the live chainId is exactly 4663.
 *  - Never assume the reward token uses 18 decimals: readRewardTokenDecimals()
 *    reads decimals() from the token itself.
 *  - Never introduce floating point on-chain: daily rates are parsed from the
 *    decimal strings in config/tiers.json into integer base units in TypeScript.
 *  - Never fabricate a deployment: address/tx data is only ever read from
 *    deployments/<network>.json or from a live receipt.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract, Signer } from 'ethers';
import { ROBINHOOD_CHAIN_ID, EXPLORER_URL } from '../../hardhat.config';

export const TIER_COUNT = 5;
export const MIN_TOKEN_ID = 1;
export const MAX_TOKEN_ID = 3333;
export const TOTAL_SUPPLY = MAX_TOKEN_ID - MIN_TOKEN_ID + 1;
export const MAX_BATCH_SIZE = 50;
export const CONTRACT_NAME = 'RobinPumpNFTStaking';

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const DEPLOYMENTS_DIR = path.join(ROOT_DIR, 'deployments');
export const FRONTEND_ABI_DIR = path.join(ROOT_DIR, 'frontend-abi');

export const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'] as const;

export interface TierConfigEntry {
  index: number;
  name: string;
  rewardPerDay: string;
}

export interface TiersConfig {
  tiers: TierConfigEntry[];
}

export interface DeploymentRecord {
  contractName: string;
  network: string;
  chainId: number;
  address: string;
  deployer: string;
  owner: string;
  nftContract: string;
  rewardToken: string;
  rewardTokenDecimals: number;
  rewardPerDayBaseUnits: string[];
  rewardPerDayHuman: string[];
  transactionHash: string;
  blockNumber: number;
  deployedAt: string;
  constructorArgs: (string | string[])[];
  explorerUrl: string;
  compiler: {
    version: string;
    optimizer: boolean;
    runs: number;
    evmVersion: string;
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Console helpers
// ───────────────────────────────────────────────────────────────────────────────

export function heading(text: string): void {
  const line = '='.repeat(Math.max(text.length, 60));
  console.log(`\n${line}\n${text}\n${line}`);
}

export function step(text: string): void {
  console.log(`\n- ${text}`);
}

export function detail(label: string, value: string | number | bigint | boolean): void {
  console.log(`    ${label.padEnd(28)} ${String(value)}`);
}

export function fail(message: string): never {
  throw new Error(message);
}

// ───────────────────────────────────────────────────────────────────────────────
// Network / signer
// ───────────────────────────────────────────────────────────────────────────────

/** Abort unless the connected RPC really is Robinhood Chain mainnet. */
export async function assertRobinhoodChain(): Promise<number> {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    fail(
      `Refusing to continue: connected chainId is ${chainId}, expected ${ROBINHOOD_CHAIN_ID} ` +
        `(Robinhood Chain mainnet). Run with --network robinhood and check ROBINHOOD_RPC.`
    );
  }
  return chainId;
}

/** The single configured deployer/owner signer, with a clear error if absent. */
export async function getDeployer(): Promise<Signer> {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    fail(
      'No signer available. Provide DEPLOYER_PRIVATE_KEY in .env, or place the key in ' +
        'the file referenced by DEPLOYER_KEY_FILE (default ../pk.txt).'
    );
  }
  return signers[0];
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Environment
// ───────────────────────────────────────────────────────────────────────────────

export function requireEnvAddress(name: string): string {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) fail(`Missing ${name} in the environment (.env).`);
  if (!ethers.isAddress(raw)) fail(`${name} is not a valid address: ${raw}`);
  return ethers.getAddress(raw);
}

export function optionalEnvAddress(name: string): string | null {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return null;
  if (!ethers.isAddress(raw)) fail(`${name} is not a valid address: ${raw}`);
  return ethers.getAddress(raw);
}

// ───────────────────────────────────────────────────────────────────────────────
// Reward token
// ───────────────────────────────────────────────────────────────────────────────

const ERC20_METADATA_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];

export function erc20At(address: string, runner?: Signer): Contract {
  return new ethers.Contract(address, ERC20_METADATA_ABI, runner ?? ethers.provider);
}

export interface RewardTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Read the reward token metadata from chain. decimals() is REQUIRED — the
 * scripts refuse to guess, because every rate conversion depends on it.
 */
export async function readRewardToken(address: string): Promise<RewardTokenInfo> {
  const token = erc20At(address);
  let decimals: number;
  try {
    decimals = Number(await token.decimals());
  } catch (err) {
    fail(
      `Could not read decimals() from the reward token at ${address}. ` +
        `Confirm the address is a live ERC-20 on this chain. Underlying error: ${
          (err as Error).message
        }`
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    fail(`Reward token at ${address} reported an implausible decimals() value: ${decimals}`);
  }

  const name = await safeString(token, 'name');
  const symbol = await safeString(token, 'symbol');
  return { address, name, symbol, decimals };
}

async function safeString(token: Contract, fn: 'name' | 'symbol'): Promise<string> {
  try {
    return String(await token[fn]());
  } catch {
    return '(unavailable)';
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Tier rates
// ───────────────────────────────────────────────────────────────────────────────

export function loadTiersConfig(): TierConfigEntry[] {
  const file = path.join(CONFIG_DIR, 'tiers.json');
  if (!fs.existsSync(file)) fail(`Missing tier config: ${file}`);

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TiersConfig;
  const tiers = parsed.tiers;
  if (!Array.isArray(tiers) || tiers.length !== TIER_COUNT) {
    fail(`config/tiers.json must contain exactly ${TIER_COUNT} tiers, found ${tiers?.length ?? 0}.`);
  }

  const sorted = [...tiers].sort((a, b) => a.index - b.index);
  sorted.forEach((tier, i) => {
    if (tier.index !== i) {
      fail(`config/tiers.json tier indexes must be 0..${TIER_COUNT - 1} with no gaps.`);
    }
    if (!/^\d+(\.\d+)?$/.test(String(tier.rewardPerDay))) {
      fail(
        `Tier ${i} (${tier.name}) has an invalid rewardPerDay "${tier.rewardPerDay}". ` +
          `Use a plain decimal string of whole reward tokens, e.g. "333.333333".`
      );
    }
  });
  return sorted;
}

/**
 * Convert the human decimal rates into integer base units for the given
 * decimals value. parseUnits throws on excess precision, which is the desired
 * behaviour: a rate that cannot be represented exactly must be corrected in
 * config, not silently truncated.
 */
export function ratesToBaseUnits(tiers: TierConfigEntry[], decimals: number): bigint[] {
  return tiers.map(tier => {
    try {
      const value = ethers.parseUnits(tier.rewardPerDay, decimals);
      if (value === 0n) {
        fail(
          `Tier ${tier.index} (${tier.name}) converts to 0 base units at ${decimals} decimals. ` +
            `The contract rejects a zero rate.`
        );
      }
      return value;
    } catch (err) {
      fail(
        `Tier ${tier.index} (${tier.name}) rate "${tier.rewardPerDay}" cannot be represented at ` +
          `${decimals} decimals. Reduce its precision in config/tiers.json. ` +
          `Underlying error: ${(err as Error).message}`
      );
    }
  });
}

export function formatUnits(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

// ───────────────────────────────────────────────────────────────────────────────
// Deployment records
// ───────────────────────────────────────────────────────────────────────────────

export function deploymentFile(networkName: string): string {
  return path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
}

export function writeDeployment(networkName: string, record: DeploymentRecord): string {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentFile(networkName);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

export function readDeployment(networkName: string): DeploymentRecord | null {
  const file = deploymentFile(networkName);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentRecord;
}

/**
 * Resolve the staking contract address, preferring an explicit override in
 * .env and falling back to the recorded deployment. Never invents a value.
 */
export function resolveStakingAddress(networkName: string): string {
  const fromEnv = optionalEnvAddress('STAKING_CONTRACT_ADDRESS');
  if (fromEnv) return fromEnv;

  const record = readDeployment(networkName);
  if (record?.address && ethers.isAddress(record.address)) {
    return ethers.getAddress(record.address);
  }

  return fail(
    `No staking contract address available. Deploy first (npm run deploy:mainnet), ` +
      `or set STAKING_CONTRACT_ADDRESS in .env.`
  );
}

export async function getStakingContract(address: string, runner?: Signer): Promise<Contract> {
  const factory = await ethers.getContractFactory(CONTRACT_NAME);
  const contract = factory.attach(address) as Contract;
  return (runner ? contract.connect(runner) : contract) as Contract;
}

/** Confirm real bytecode lives at `address` before sending admin transactions. */
export async function assertContractDeployed(address: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === '0x' || code === '0x0') {
    fail(`No contract bytecode found at ${address} on this chain. Refusing to continue.`);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Misc
// ───────────────────────────────────────────────────────────────────────────────

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Wrap a script body so every failure exits non-zero with a clear message. */
export function runScript(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(`\nFAILED: ${(err as Error).message}`);
      process.exit(1);
    });
}
