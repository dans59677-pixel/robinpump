/**
 * Permanently freeze the rarity mapping.
 *
 *   npm run lock:rarity
 *
 * This is IRREVERSIBLE. Once lockRarity() succeeds, setTokenTier(),
 * setTokenTiers() and lockRarity() itself all revert with RarityAlreadyLocked()
 * for the lifetime of the contract.
 *
 * The contract requires configuredCount == 3333 before it will lock, and this
 * script additionally requires an explicit CONFIRM_LOCK_RARITY=YES so that the
 * lock can never happen as a side effect of running the wrong npm script.
 */

import hre from 'hardhat';
import {
  TIER_NAMES,
  TOTAL_SUPPLY,
  assertContractDeployed,
  assertRobinhoodChain,
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

async function main(): Promise<void> {
  heading('Lock rarity — IRREVERSIBLE');

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
    fail(`Caller is not the owner (${owner}). lockRarity() is onlyOwner and would revert.`);
  }

  if (await staking.rarityLocked()) {
    step('Rarity is already locked on this contract. Nothing to do.');
    return;
  }

  const configuredCount = Number(await staking.configuredCount());
  const tierCounts: bigint[] = [...(await staking.getTierCounts())];

  step('Current rarity coverage');
  detail('configuredCount', `${configuredCount} / ${TOTAL_SUPPLY}`);
  TIER_NAMES.forEach((name, tier) => detail(`tier ${tier} ${name}`, tierCounts[tier].toString()));

  if (configuredCount !== TOTAL_SUPPLY) {
    fail(
      `Only ${configuredCount} of ${TOTAL_SUPPLY} token ids have a tier. ` +
        `lockRarity() would revert with RarityIncomplete(). ` +
        `Finish npm run configure:tiers:csv first.`
    );
  }

  const confirm = (process.env.CONFIRM_LOCK_RARITY ?? '').trim().toUpperCase();
  if (confirm !== 'YES') {
    fail(
      'Refusing to lock without explicit confirmation.\n' +
        '    This action is permanent and cannot be undone or upgraded.\n' +
        '    To proceed, set CONFIRM_LOCK_RARITY=YES in .env (or in the environment) and re-run.'
    );
  }

  step('Sending lockRarity()');
  const tx = await staking.lockRarity();
  detail('tx hash', tx.hash);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`lockRarity() reverted (tx ${tx.hash}).`);
  detail('block', receipt.blockNumber);
  detail('gas used', receipt.gasUsed.toString());
  detail('explorer', explorerTxUrl(tx.hash));

  step('Verifying');
  const locked: boolean = await staking.rarityLocked();
  if (!locked) fail('Transaction succeeded but rarityLocked() still reads false.');
  detail('rarityLocked', locked);
  console.log(
    `\nRarity for all ${TOTAL_SUPPLY} token ids is now immutable. ` +
      `No address, including the owner, can change it.`
  );
}

runScript(main);
