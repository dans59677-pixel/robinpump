/**
 * Read-only pre-flight: resolves the deployer key, checks the chain id and
 * prints the address plus native balance. Sends no transaction.
 */
import { ethers } from 'hardhat';
import { assertRobinhoodChain, getDeployer, heading, runScript } from './lib/common';

runScript(async () => {
  heading('Deployer pre-flight');
  const chainId = await assertRobinhoodChain();
  const deployer = await getDeployer();
  const address = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(address);
  const nonce = await ethers.provider.getTransactionCount(address);

  console.log(`    chainId    ${chainId}`);
  console.log(`    deployer   ${address}`);
  console.log(`    balance    ${ethers.formatEther(balance)} ETH`);
  console.log(`    nonce      ${nonce}`);

  if (balance === 0n) {
    console.log('\n    Balance is zero. Fund this address before deploying.');
  }
});
