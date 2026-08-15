/**
 * Submit the contract source to Blockscout for verification.
 *
 *   npm run verify:contract
 *
 * Constructor arguments are taken from deployments/<network>.json — the record
 * written by deploy.ts — so they cannot drift from what was actually deployed.
 *
 * This script reports the verification status Blockscout returns. It never
 * claims a contract is verified without that confirmation.
 */

import hre from 'hardhat';
import {
  CONTRACT_NAME,
  assertContractDeployed,
  assertRobinhoodChain,
  detail,
  explorerAddressUrl,
  fail,
  heading,
  readDeployment,
  runScript,
  step
} from './lib/common';

function isAlreadyVerified(message: string): boolean {
  return /already verified|already been verified|smart-contract already verified/i.test(message);
}

async function main(): Promise<void> {
  heading('Verify source on Blockscout');

  const chainId = await assertRobinhoodChain();
  const networkName = hre.network.name;

  const record = readDeployment(networkName);
  if (!record) {
    fail(
      `No deployment record at deployments/${networkName}.json. ` +
        `Verification needs the exact constructor arguments used at deploy time, ` +
        `so deploy through npm run deploy:mainnet first.`
    );
  }
  if (record.chainId !== chainId) {
    fail(
      `deployments/${networkName}.json records chainId ${record.chainId}, ` +
        `but the connected chain is ${chainId}.`
    );
  }

  await assertContractDeployed(record.address);

  const constructorArguments = [
    record.nftContract,
    record.rewardToken,
    record.owner,
    record.rewardPerDayBaseUnits
  ];

  step('Submitting');
  detail('contract', CONTRACT_NAME);
  detail('address', record.address);
  detail('chainId', chainId);
  detail('deployed in block', record.blockNumber);
  detail('compiler', `${record.compiler.version} (optimizer ${record.compiler.runs} runs)`);
  detail('evmVersion', record.compiler.evmVersion);
  console.log('    constructor args:');
  console.log(`      nft            ${record.nftContract}`);
  console.log(`      rewardToken    ${record.rewardToken}`);
  console.log(`      initialOwner   ${record.owner}`);
  console.log(`      ratesPerDay    [${record.rewardPerDayBaseUnits.join(', ')}]`);

  try {
    await hre.run('verify:verify', {
      address: record.address,
      constructorArguments,
      contract: `contracts/${CONTRACT_NAME}.sol:${CONTRACT_NAME}`
    });
    step('Blockscout accepted the submission');
    detail('status', 'verified');
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (isAlreadyVerified(message)) {
      step('Blockscout reports this address is already verified');
      detail('status', 'already verified');
    } else {
      step('Verification did NOT succeed');
      detail('status', 'failed');
      console.log(`\n    Blockscout returned:\n    ${message}\n`);
      console.log(
        [
          '    Common causes:',
          '      - the explorer has not yet indexed the deployment; wait and retry',
          '      - a Blockscout instance that needs the standard-json flow instead',
          '      - compiler settings that differ from the deployed bytecode',
          '',
          '    The contract itself is unaffected: a failed verification does not',
          '    change deployed code or state.'
        ].join('\n')
      );
      throw new Error('Blockscout verification failed; see the message above.');
    }
  }

  detail('explorer', explorerAddressUrl(record.address));
}

runScript(main);
