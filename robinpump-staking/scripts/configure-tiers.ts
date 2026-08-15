/**
 * Push the per-tier daily reward rates from config/tiers.json onto the deployed
 * contract.
 *
 *   npm run configure:tiers
 *
 * This configures RATES ONLY (5 values). Per-token rarity is a separate step,
 * handled by configure-tiers-from-csv.ts.
 *
 * Rates are converted to base units using the reward token's live decimals(),
 * and the script skips the transaction entirely when the on-chain values
 * already match, so it is safe to re-run.
 */

import hre, { ethers } from 'hardhat';
import {
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  explorerTxUrl,
  fail,
  getDeployer,
  getStakingContract,
  heading,
  loadTiersConfig,
  ratesToBaseUnits,
  readRewardToken,
  resolveStakingAddress,
  runScript,
  step
} from './lib/common';

async function main(): Promise<void> {
  heading('Configure per-tier reward rates');

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
  detail('contract owner', owner);
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    fail(`Caller is not the owner. setRewardRates() is onlyOwner and would revert.`);
  }

  // Read decimals from the token the CONTRACT actually points at.
  const rewardTokenAddress: string = await staking.rewardToken();
  const token = await readRewardToken(rewardTokenAddress);
  step('Reward token');
  detail('address', token.address);
  detail('symbol', token.symbol);
  detail('decimals', token.decimals);

  const tiers = loadTiersConfig();
  const desired = ratesToBaseUnits(tiers, token.decimals);
  const current: bigint[] = [...(await staking.getRewardRates())];

  step('Rate comparison');
  let changed = false;
  tiers.forEach((tier, i) => {
    const same = current[i] === desired[i];
    if (!same) changed = true;
    detail(
      `${tier.index} ${tier.name}`,
      `${tier.rewardPerDay} ${token.symbol}/day -> ${desired[i].toString()}` +
        (same ? '  (already set)' : `  (was ${current[i].toString()})`)
    );
  });

  if (!changed) {
    step('Nothing to do — every on-chain rate already matches config/tiers.json.');
    return;
  }

  step('Sending setRewardRates()');
  const tx = await staking.setRewardRates(desired);
  detail('tx hash', tx.hash);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`setRewardRates() reverted (tx ${tx.hash}).`);
  detail('block', receipt.blockNumber);
  detail('gas used', receipt.gasUsed.toString());
  detail('explorer', explorerTxUrl(tx.hash));

  step('Verifying on-chain state');
  const after: bigint[] = [...(await staking.getRewardRates())];
  after.forEach((value, i) => {
    if (value !== desired[i]) {
      fail(`Tier ${i} still reads ${value}, expected ${desired[i]}.`);
    }
  });
  detail('all five rates confirmed', 'yes');
  console.log(
    `\nRates are live. Per-token rarity is still separate: run ` +
      `npm run configure:tiers:csv, then npm run lock:rarity.`
  );
}

runScript(main);
