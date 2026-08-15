/**
 * Deploy RobinPumpNFTStaking to Robinhood Chain mainnet (chain 4663).
 *
 *   npm run deploy:mainnet
 *
 * The script refuses to run unless:
 *   - the connected chainId is exactly 4663
 *   - NFT_CONTRACT_ADDRESS and REWARD_TOKEN_ADDRESS are valid addresses with
 *     real bytecode on this chain
 *   - the reward token answers decimals()
 *   - the deployer holds native gas
 *
 * Nothing about the result is invented: the address, transaction hash and block
 * number written to deployments/<network>.json all come from the live receipt.
 */

import hre, { ethers } from 'hardhat';
import {
  CONTRACT_NAME,
  DeploymentRecord,
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  explorerAddressUrl,
  explorerTxUrl,
  fail,
  formatUnits,
  getDeployer,
  heading,
  loadTiersConfig,
  optionalEnvAddress,
  ratesToBaseUnits,
  readRewardToken,
  requireEnvAddress,
  runScript,
  step,
  writeDeployment
} from './lib/common';

async function main(): Promise<void> {
  heading('RobinPump NFT Staking — mainnet deployment');

  const chainId = await assertRobinhoodChain();
  const networkName = hre.network.name;
  const deployer = await getDeployer();
  const deployerAddress = await deployer.getAddress();

  step('Network and signer');
  detail('network', networkName);
  detail('chainId', chainId);
  detail('deployer', deployerAddress);

  const balance = await ethers.provider.getBalance(deployerAddress);
  detail('native balance', `${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    fail('Deployer has zero native balance; it cannot pay for gas. Fund it and retry.');
  }

  // ── Inputs ────────────────────────────────────────────────────────────────
  const nftAddress = requireEnvAddress('NFT_CONTRACT_ADDRESS');
  const rewardAddress = requireEnvAddress('REWARD_TOKEN_ADDRESS');
  const owner = optionalEnvAddress('OWNER_ADDRESS') ?? deployerAddress;

  step('Verifying the external contracts exist on this chain');
  await assertContractDeployed(nftAddress);
  await assertContractDeployed(rewardAddress);
  detail('NFT collection', nftAddress);
  detail('reward token', rewardAddress);

  const token = await readRewardToken(rewardAddress);
  step('Reward token metadata (read from chain, never assumed)');
  detail('name', token.name);
  detail('symbol', token.symbol);
  detail('decimals', token.decimals);

  // ── Rates ─────────────────────────────────────────────────────────────────
  const tiers = loadTiersConfig();
  const rates = ratesToBaseUnits(tiers, token.decimals);

  step('Daily reward rates converted to base units');
  tiers.forEach((tier, i) => {
    detail(
      `${tier.index} ${tier.name}`,
      `${tier.rewardPerDay} ${token.symbol}/day  ->  ${rates[i].toString()}`
    );
  });

  // ── Deploy ────────────────────────────────────────────────────────────────
  step('Deploying');
  detail('contract', CONTRACT_NAME);
  detail('initialOwner', owner);

  const factory = await ethers.getContractFactory(CONTRACT_NAME, deployer);
  const contract = await factory.deploy(nftAddress, rewardAddress, owner, rates);
  const deployTx = contract.deploymentTransaction();
  if (!deployTx) fail('Deployment transaction was not returned by the provider.');
  detail('tx hash', deployTx.hash);

  console.log('    waiting for the transaction to be mined...');
  await contract.waitForDeployment();

  const receipt = await ethers.provider.getTransactionReceipt(deployTx.hash);
  if (!receipt) fail(`Could not fetch the receipt for ${deployTx.hash}.`);
  if (receipt.status !== 1) fail(`Deployment transaction reverted (status ${receipt.status}).`);

  const address = await contract.getAddress();

  step('Deployed');
  detail('address', address);
  detail('block', receipt.blockNumber);
  detail('gas used', receipt.gasUsed.toString());
  detail('explorer', explorerAddressUrl(address));
  detail('tx', explorerTxUrl(deployTx.hash));

  // ── Post-deploy sanity read-back ──────────────────────────────────────────
  step('Reading state back from the deployed contract');
  const onChainRates: bigint[] = [...(await contract.getRewardRates())];
  onChainRates.forEach((value, i) => {
    if (value !== rates[i]) {
      fail(`Rate mismatch for tier ${i}: expected ${rates[i]}, contract holds ${value}.`);
    }
  });
  detail('rates match config', 'yes');
  detail('nftContract', await contract.nftContract());
  detail('rewardToken', await contract.rewardToken());
  detail('owner', await contract.owner());
  detail('rarityLocked', await contract.rarityLocked());
  detail('configuredCount', (await contract.configuredCount()).toString());

  // ── Persist ───────────────────────────────────────────────────────────────
  const compiler = hre.config.solidity.compilers[0];
  const record: DeploymentRecord = {
    contractName: CONTRACT_NAME,
    network: networkName,
    chainId,
    address,
    deployer: deployerAddress,
    owner,
    nftContract: nftAddress,
    rewardToken: rewardAddress,
    rewardTokenDecimals: token.decimals,
    rewardPerDayBaseUnits: rates.map(r => r.toString()),
    rewardPerDayHuman: rates.map(r => formatUnits(r, token.decimals)),
    transactionHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    constructorArgs: [nftAddress, rewardAddress, owner, rates.map(r => r.toString())],
    explorerUrl: explorerAddressUrl(address),
    compiler: {
      version: compiler.version,
      optimizer: Boolean(compiler.settings?.optimizer?.enabled),
      runs: Number(compiler.settings?.optimizer?.runs ?? 0),
      evmVersion: String(compiler.settings?.evmVersion ?? 'default')
    }
  };
  const file = writeDeployment(networkName, record);

  step('Deployment record written');
  detail('file', file);

  heading('NEXT STEPS');
  console.log(
    [
      `1. Put the address in .env:`,
      `       STAKING_CONTRACT_ADDRESS=${address}`,
      `       NEXT_PUBLIC_STAKING_CONTRACT_ADDRESS=${address}`,
      `2. Assign rarity for all 3333 token ids:`,
      `       npm run configure:tiers:csv        (config/token-tiers.csv)`,
      `3. Freeze rarity once every id is set:`,
      `       npm run lock:rarity`,
      `4. Fund the reward pool:`,
      `       npm run fund:rewards               (FUND_AMOUNT in .env)`,
      `5. Verify the source on Blockscout:`,
      `       npm run verify:contract`,
      `6. Export the ABI for the front end:`,
      `       npm run abi`,
      `7. Check everything:`,
      `       npm run status`
    ].join('\n')
  );
}

runScript(main);
