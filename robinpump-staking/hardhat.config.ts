import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-network-helpers';
import '@nomicfoundation/hardhat-verify';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

/**
 * Resolve the deployer key without ever putting it in source control.
 *
 * Order of preference:
 *   1. DEPLOYER_PRIVATE_KEY in the environment / .env
 *   2. A local key file (default ../pk.txt), which .gitignore excludes
 *
 * Returns an empty account list when no key is available so that `compile`
 * and `test` still work on a machine with no key at all.
 */
export function resolveDeployerKey(): string | null {
  const fromEnv = (process.env.DEPLOYER_PRIVATE_KEY ?? '').trim();
  if (fromEnv) return normalizeKey(fromEnv, 'DEPLOYER_PRIVATE_KEY');

  const keyFile = (process.env.DEPLOYER_KEY_FILE ?? '../pk.txt').trim();
  const resolved = path.resolve(__dirname, keyFile);
  if (fs.existsSync(resolved)) {
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    if (raw) return normalizeKey(raw, keyFile);
  }
  return null;
}

function normalizeKey(raw: string, source: string): string {
  // Tolerate a trailing newline, surrounding quotes, or a missing 0x prefix.
  let key = raw.replace(/^['"]|['"]$/g, '').trim();
  if (!key.startsWith('0x')) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `Deployer key from ${source} is not a 32-byte hex private key. ` +
        `Expected 64 hex characters (with or without the 0x prefix).`
    );
  }
  return key;
}

const deployerKey = resolveDeployerKey();

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Robinhood Chain is an Arbitrum L2; cancun opcodes are not assumed.
      evmVersion: 'paris',
      metadata: { bytecodeHash: 'none' }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false
    },
    robinhood: {
      url: process.env.ROBINHOOD_RPC || DEFAULT_RPC,
      chainId: ROBINHOOD_CHAIN_ID,
      accounts: deployerKey ? [deployerKey] : []
    }
  },
  etherscan: {
    // Blockscout accepts any non-empty key string.
    apiKey: {
      robinhood: process.env.BLOCKSCOUT_API_KEY || 'blockscout'
    },
    customChains: [
      {
        network: 'robinhood',
        chainId: ROBINHOOD_CHAIN_ID,
        urls: {
          apiURL: `${EXPLORER_URL}/api`,
          browserURL: EXPLORER_URL
        }
      }
    ]
  },
  sourcify: { enabled: false },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts'
  },
  mocha: { timeout: 120_000 }
};

export default config;
