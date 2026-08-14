/*
 * RobinPump staking configuration
 *
 * This file deliberately contains only independently verified, public data.
 * Do not set `enabled` to true until every required address and the full
 * on-chain rarity mapping have been verified and the reward pool is funded.
 */
window.RobinPumpStakingConfig = Object.freeze({
  enabled: false,
  network: Object.freeze({
    chainId: 4663,
    chainIdHex: '0x1237',
    label: 'Robinhood Chain',
    currencySymbol: 'ETH',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com'
  }),
  rewardToken: Object.freeze({
    address: '0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf',
    name: 'Robin Pump',
    symbol: 'ROBINPUMP',
    decimals: 18,
    supply: '1000000000000000000000000000',
    standard: 'ERC-20',
    explorerUrl: 'https://robinhoodchain.blockscout.com/address/0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf'
  }),
  greenFlockCollection: Object.freeze({
    address: '0xbd00ce673b84be8022af8be0039c7a5af69724a9',
    standard: 'ERC-721',
    enumerable: false,
    explorerUrl: 'https://robinhoodchain.blockscout.com/address/0xbd00ce673b84be8022af8be0039c7a5af69724a9'
  }),
  /*
   * Display defaults only. These mirror MIN_LOCK_DURATION / MAX_LOCK_DURATION /
   * CLAIM_COOLDOWN in GreenFlockStaking.sol so the lock picker can render before
   * the first RPC returns. staking.js overwrites them with the authoritative
   * values from lockBounds() as soon as the contract is read — never treat these
   * as the source of truth.
   */
  lockRules: Object.freeze({
    minSeconds: 7 * 86400,      // 7 days
    maxSeconds: 1095 * 86400,   // 3 years
    claimCooldownSeconds: 86400 // 24h per NFT
  }),
  /*
   * Selectors are derived at runtime by keccak-256 over these canonical
   * signatures (see SEL in staking.js). Recorded here so the deployed ABI can be
   * diffed against what the frontend calls.
   */
  stakingAbiSignatures: Object.freeze([
    'stake(uint256,uint256)',
    'unstake(uint256)',
    'claimReward(uint256)',
    'claimAllRewards()',
    'stakedTokenIds(address)',
    'stakeDetails(uint256)',
    'rewardRateOf(address)',
    'lockBounds()'
  ]),
  // Intentionally null: do not invent a transaction target.
  stakingContract: null,
  rarityMapping: null,
  rewardPool: null
});
