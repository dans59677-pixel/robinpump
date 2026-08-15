/**
 * Transfer reward tokens into the staking contract's reward pool.
 *
 *   npm run fund:rewards
 *
 * Amount comes from FUND_AMOUNT in .env, expressed in WHOLE reward tokens
 * (e.g. FUND_AMOUNT=5000000). It is converted to base units with the token's
 * live decimals().
 *
 * fundRewards() is onlyOwner and measures the balance delta itself, so the
 * emitted RewardsFunded amount reflects what actually arrived even if the token
 * charges a transfer fee.
 */

import hre, { ethers } from 'hardhat';
import {
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  erc20At,
  explorerTxUrl,
  fail,
  formatUnits,
  getDeployer,
  getStakingContract,
  heading,
  readRewardToken,
  resolveStakingAddress,
  runScript,
  step
} from './lib/common';

async function main(): Promise<void> {
  heading('Fund the reward pool');

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
    fail(`Caller is not the owner (${owner}). fundRewards() is onlyOwner and would revert.`);
  }

  const rewardTokenAddress: string = await staking.rewardToken();
  const token = await readRewardToken(rewardTokenAddress);
  step('Reward token');
  detail('address', token.address);
  detail('symbol', token.symbol);
  detail('decimals', token.decimals);

  const raw = (process.env.FUND_AMOUNT ?? '').trim();
  if (!raw) {
    fail('Set FUND_AMOUNT in .env to the number of whole reward tokens to deposit.');
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    fail(`FUND_AMOUNT "${raw}" must be a plain decimal number of whole tokens.`);
  }

  let amount: bigint;
  try {
    amount = ethers.parseUnits(raw, token.decimals);
  } catch (err) {
    fail(`FUND_AMOUNT "${raw}" cannot be represented at ${token.decimals} decimals.`);
  }
  if (amount === 0n) fail('FUND_AMOUNT converts to zero base units.');

  const erc20 = erc20At(token.address, deployer);
  const walletBalance: bigint = await erc20.balanceOf(deployerAddress);
  const poolBefore: bigint = await staking.rewardTokenBalance();

  step('Amounts');
  detail('to deposit', `${formatUnits(amount, token.decimals)} ${token.symbol}`);
  detail('base units', amount.toString());
  detail('your balance', `${formatUnits(walletBalance, token.decimals)} ${token.symbol}`);
  detail('pool before', `${formatUnits(poolBefore, token.decimals)} ${token.symbol}`);

  if (walletBalance < amount) {
    fail(
      `Insufficient reward-token balance: have ${formatUnits(walletBalance, token.decimals)}, ` +
        `need ${formatUnits(amount, token.decimals)} ${token.symbol}.`
    );
  }

  // ── Approve exactly the amount required ───────────────────────────────────
  const allowance: bigint = await erc20.allowance(deployerAddress, address);
  if (allowance < amount) {
    step('Approving the staking contract to pull the deposit');
    detail('current allowance', allowance.toString());
    const approveTx = await erc20.approve(address, amount);
    detail('tx hash', approveTx.hash);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt || approveReceipt.status !== 1) {
      fail(`approve() reverted (tx ${approveTx.hash}).`);
    }
    detail('approved', formatUnits(amount, token.decimals));
  } else {
    step('Existing allowance already covers the deposit; skipping approve()');
  }

  // ── Fund ──────────────────────────────────────────────────────────────────
  step('Sending fundRewards()');
  const tx = await staking.fundRewards(amount);
  detail('tx hash', tx.hash);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`fundRewards() reverted (tx ${tx.hash}).`);
  detail('block', receipt.blockNumber);
  detail('gas used', receipt.gasUsed.toString());
  detail('explorer', explorerTxUrl(tx.hash));

  const poolAfter: bigint = await staking.rewardTokenBalance();
  const received = poolAfter - poolBefore;

  step('Reward pool');
  detail('pool after', `${formatUnits(poolAfter, token.decimals)} ${token.symbol}`);
  detail('actually received', `${formatUnits(received, token.decimals)} ${token.symbol}`);
  if (received !== amount) {
    console.log(
      `\n    NOTE: the pool grew by ${formatUnits(received, token.decimals)} but ` +
        `${formatUnits(amount, token.decimals)} was sent. This token appears to ` +
        `charge a transfer fee; the contract recorded the real delta.`
    );
  }
}

runScript(main);
