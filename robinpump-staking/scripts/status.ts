/**
 * Read-only health report for a deployed RobinPumpNFTStaking contract.
 *
 * Sends no transactions and needs no private key: every value below is read
 * from chain, from config/tiers.json, or from deployments/<network>.json.
 * Nothing here is inferred or filled in with a plausible default — if a value
 * cannot be read, the script says so instead of printing a guess.
 *
 *   npm run status
 */

import { ethers, network } from 'hardhat';
import {
  CONTRACT_NAME,
  TIER_COUNT,
  TIER_NAMES,
  TOTAL_SUPPLY,
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  explorerAddressUrl,
  formatUnits,
  getStakingContract,
  heading,
  loadTiersConfig,
  ratesToBaseUnits,
  readDeployment,
  readRewardToken,
  resolveStakingAddress,
  runScript,
  step
} from './lib/common';

/** A single readiness check, rendered as PASS / WARN / BLOCKED. */
interface Check {
  label: string;
  state: 'PASS' | 'WARN' | 'BLOCKED';
  note: string;
}

function renderChecks(checks: Check[]): void {
  const width = Math.max(...checks.map(c => c.label.length));
  for (const check of checks) {
    console.log(`    [${check.state.padEnd(7)}] ${check.label.padEnd(width)}  ${check.note}`);
  }
}

async function main(): Promise<void> {
  heading(`${CONTRACT_NAME} — status report`);

  const chainId = await assertRobinhoodChain();
  const address = resolveStakingAddress(network.name);
  await assertContractDeployed(address);

  detail('network', `${network.name} (chainId ${chainId})`);
  detail('staking contract', address);
  detail('explorer', explorerAddressUrl(address));

  const record = readDeployment(network.name);
  if (record) {
    detail('deployed at', record.deployedAt);
    detail('deploy tx', record.transactionHash);
    detail('deploy block', record.blockNumber);
  } else {
    detail('deployment record', 'none on disk (address came from STAKING_CONTRACT_ADDRESS)');
  }

  const staking = await getStakingContract(address);

  // ── Immutable wiring ──────────────────────────────────────────────────────
  step('Immutable wiring');
  const nftAddress: string = await staking.nftContract();
  const rewardAddress: string = await staking.rewardToken();
  const owner: string = await staking.owner();

  detail('nftContract', nftAddress);
  detail('rewardToken', rewardAddress);
  detail('owner', owner);

  const nftCode = await ethers.provider.getCode(nftAddress);
  const rewardCode = await ethers.provider.getCode(rewardAddress);
  detail('nftContract has code', nftCode !== '0x' && nftCode !== '0x0');
  detail('rewardToken has code', rewardCode !== '0x' && rewardCode !== '0x0');

  const token = await readRewardToken(rewardAddress);
  detail('reward token', `${token.name} (${token.symbol})`);
  detail('reward decimals', token.decimals);

  // ── Operational state ─────────────────────────────────────────────────────
  step('Operational state');
  const paused: boolean = await staking.paused();
  const rarityLocked: boolean = await staking.rarityLocked();
  const configuredCount: bigint = await staking.configuredCount();
  const totalStaked: bigint = await staking.totalStaked();
  const totalRewardsPaid: bigint = await staking.totalRewardsPaid();
  const poolBalance: bigint = await staking.rewardTokenBalance();

  detail('paused (deposits)', paused ? 'YES — staking blocked' : 'no');
  detail('rarityLocked', rarityLocked ? 'YES — permanent' : 'no (tiers still editable)');
  detail('tiers configured', `${configuredCount} / ${TOTAL_SUPPLY}`);
  detail('NFTs staked', totalStaked);
  detail('rewards paid to date', `${formatUnits(totalRewardsPaid, token.decimals)} ${token.symbol}`);
  detail('reward pool balance', `${formatUnits(poolBalance, token.decimals)} ${token.symbol}`);

  // ── Rates: on-chain vs config ─────────────────────────────────────────────
  step('Reward rates (on-chain vs config/tiers.json)');
  const onChainRates: bigint[] = [...(await staking.getRewardRates())];
  const configured = loadTiersConfig();
  const expectedRates = ratesToBaseUnits(configured, token.decimals);

  let rateDrift = 0;
  let zeroRates = 0;
  for (let i = 0; i < TIER_COUNT; i++) {
    const onChain = onChainRates[i];
    const expected = expectedRates[i];
    const matches = onChain === expected;
    if (!matches) rateDrift++;
    if (onChain === 0n) zeroRates++;

    const suffix = matches
      ? 'matches config'
      : `DIFFERS from config (${formatUnits(expected, token.decimals)}/day)`;
    detail(
      `${i} ${TIER_NAMES[i]}`,
      `${formatUnits(onChain, token.decimals)} ${token.symbol}/day — ${suffix}`
    );
  }

  // ── Tier distribution ─────────────────────────────────────────────────────
  step('Configured tier distribution');
  const tierCounts: bigint[] = [...(await staking.getTierCounts())];
  let fullCollectionDailyEmission = 0n;
  for (let i = 0; i < TIER_COUNT; i++) {
    detail(`${i} ${TIER_NAMES[i]}`, `${tierCounts[i]} ids`);
    fullCollectionDailyEmission += tierCounts[i] * onChainRates[i];
  }

  // ── Emission and runway ───────────────────────────────────────────────────
  step('Emission ceiling and pool runway');
  console.log(
    '    Only the per-tier counts of CONFIGURED ids are on-chain; the contract does not\n' +
      '    expose a per-tier breakdown of what is currently staked. The figures below are\n' +
      '    therefore the worst case (every configured id staked), not the current burn rate.'
  );
  detail(
    'max daily emission',
    `${formatUnits(fullCollectionDailyEmission, token.decimals)} ${token.symbol}/day`
  );

  if (fullCollectionDailyEmission > 0n) {
    const daysOfRunway = poolBalance / fullCollectionDailyEmission;
    detail('worst-case runway', `${daysOfRunway} full day(s) at that ceiling`);
  } else {
    detail('worst-case runway', 'not computable (no configured ids, or all rates are 0)');
  }

  // ── Readiness ─────────────────────────────────────────────────────────────
  step('Readiness');
  const checks: Check[] = [];

  checks.push(
    nftCode !== '0x' && rewardCode !== '0x'
      ? { label: 'external contracts live', state: 'PASS', note: 'both addresses hold bytecode' }
      : {
          label: 'external contracts live',
          state: 'BLOCKED',
          note: 'an immutable address holds no code on this chain'
        }
  );

  checks.push(
    zeroRates === 0
      ? { label: 'all 5 rates set', state: 'PASS', note: 'no tier is zero' }
      : {
          label: 'all 5 rates set',
          state: 'BLOCKED',
          note: `${zeroRates} tier(s) at 0 — stake() reverts with RewardRateNotSet for them`
        }
  );

  checks.push(
    rateDrift === 0
      ? { label: 'rates match config', state: 'PASS', note: 'chain agrees with config/tiers.json' }
      : {
          label: 'rates match config',
          state: 'WARN',
          note: `${rateDrift} tier(s) differ — run "npm run configure:tiers" to realign`
        }
  );

  const fullyConfigured = configuredCount === BigInt(TOTAL_SUPPLY);
  checks.push(
    fullyConfigured
      ? { label: 'rarity complete', state: 'PASS', note: `all ${TOTAL_SUPPLY} ids mapped` }
      : {
          label: 'rarity complete',
          state: 'BLOCKED',
          note: `${TOTAL_SUPPLY - Number(configuredCount)} id(s) missing — those ids cannot be staked`
        }
  );

  checks.push(
    rarityLocked
      ? { label: 'rarity locked', state: 'PASS', note: 'permanently frozen' }
      : {
          label: 'rarity locked',
          state: 'WARN',
          note: fullyConfigured
            ? 'ready to lock — CONFIRM_LOCK_RARITY=YES npm run lock:rarity'
            : 'cannot lock until every id is mapped'
        }
  );

  checks.push(
    poolBalance > 0n
      ? {
          label: 'reward pool funded',
          state: 'PASS',
          note: `${formatUnits(poolBalance, token.decimals)} ${token.symbol} available`
        }
      : {
          label: 'reward pool funded',
          state: 'BLOCKED',
          note: 'empty — claim() reverts with InsufficientRewardPool'
        }
  );

  checks.push(
    paused
      ? { label: 'deposits open', state: 'WARN', note: 'contract is paused; claim/unstake still work' }
      : { label: 'deposits open', state: 'PASS', note: 'stake() accepting deposits' }
  );

  renderChecks(checks);

  const blocked = checks.filter(c => c.state === 'BLOCKED');
  const warned = checks.filter(c => c.state === 'WARN');

  heading(
    blocked.length > 0
      ? `NOT READY — ${blocked.length} blocking issue(s)`
      : warned.length > 0
        ? `USABLE — ${warned.length} warning(s), no blocking issues`
        : 'READY — all checks passed'
  );

  if (blocked.length > 0) {
    console.log('  Blocking:');
    blocked.forEach(c => console.log(`    - ${c.label}: ${c.note}`));
  }
  if (warned.length > 0) {
    console.log('  Warnings:');
    warned.forEach(c => console.log(`    - ${c.label}: ${c.note}`));
  }
  console.log('');
}

runScript(main);
