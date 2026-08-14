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
    explorerUrl: 'https://robinhoodchain.blockscout.com/token/0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf'
  }),
  greenFlockCollection: Object.freeze({
    address: '0xbd00ce673b84be8022af8be0039c7a5af69724a9',
    standard: 'ERC-721',
    enumerable: false,
    explorerUrl: 'https://robinhoodchain.blockscout.com/token/0xbd00ce673b84be8022af8be0039c7a5af69724a9'
  }),
  // Intentionally null: do not invent a transaction target.
  stakingContract: null,
  rarityMapping: null,
  rewardPool: null
});
