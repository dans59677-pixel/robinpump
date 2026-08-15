/**
 * Read-only cost estimate for the staking deployment. Sends no transaction:
 * it builds the exact deploy calldata, asks the node to estimate gas, reads the
 * live fee data, and compares the total against the deployer balance.
 */
import hre, { ethers } from 'hardhat';
import {
  CONTRACT_NAME,
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  getDeployer,
  heading,
  loadTiersConfig,
  optionalEnvAddress,
  ratesToBaseUnits,
  readRewardToken,
  requireEnvAddress,
  runScript,
  step
} from './lib/common';

runScript(async () => {
  heading('Deployment cost estimate (no transaction sent)');

  const chainId = await assertRobinhoodChain();
  const deployer = await getDeployer();
  const from = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(from);

  step('Signer');
  detail('chainId', chainId);
  detail('deployer', from);
  detail('balance', `${ethers.formatEther(balance)} ETH`);

  const nftAddress = requireEnvAddress('NFT_CONTRACT_ADDRESS');
  const rewardAddress = requireEnvAddress('REWARD_TOKEN_ADDRESS');
  const owner = optionalEnvAddress('OWNER_ADDRESS') ?? from;

  await assertContractDeployed(nftAddress);
  await assertContractDeployed(rewardAddress);

  const token = await readRewardToken(rewardAddress);
  const rates = ratesToBaseUnits(loadTiersConfig(), token.decimals);

  const factory = await ethers.getContractFactory(CONTRACT_NAME, deployer);
  const tx = await factory.getDeployTransaction(nftAddress, rewardAddress, owner, rates);

  step('Estimating');
  const gas = await ethers.provider.estimateGas({ ...tx, from });
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  if (gasPrice === null || gasPrice === undefined) {
    throw new Error('Node returned no gas price.');
  }

  const cost = gas * gasPrice;
  const bytecodeBytes = ((tx.data as string).length - 2) / 2;

  detail('calldata size', `${bytecodeBytes} bytes`);
  detail('gas estimate', gas.toString());
  detail('gas price', `${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  detail('estimated cost', `${ethers.formatEther(cost)} ETH`);
  detail('balance', `${ethers.formatEther(balance)} ETH`);

  const headroom = balance - cost;
  step('Verdict');
  if (headroom < 0n) {
    detail('result', 'INSUFFICIENT');
    detail('shortfall', `${ethers.formatEther(-headroom)} ETH`);
    console.log('\n    Fund the deployer before running deploy:mainnet.');
  } else {
    detail('result', 'SUFFICIENT for the deploy itself');
    detail('left over', `${ethers.formatEther(headroom)} ETH`);
    console.log(
      [
        '',
        '    Note: configure:tiers:csv sends 67 further transactions (3333 ids in',
        '    chunks of 50), plus configure:tiers, fund:rewards and lock:rarity.',
        '    Those need their own gas beyond the figure above.'
      ].join('\n')
    );
  }

  void hre;
});
