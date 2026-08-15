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
    /*
     * Wallet-facing only. These are handed to wallet_addEthereumChain so the
     * wallet can add chain 4663 itself; the dapp never reads the chain through
     * them (every eth_call goes through the injected provider).
     *
     * Because this file ships to the browser, only public endpoints belong here.
     * Never paste the keyed Alchemy URL from robinpump-staking/.env — that would
     * publish the API key to every visitor.
     *
     * If this host ever fails locally with a TLS/certificate error, that is DNS
     * interception on the client network, not a fault in the endpoint. Wallets
     * try the entries in order, so extra public mirrors can be appended here.
     */
    rpcUrls: Object.freeze([
      'https://rpc.mainnet.chain.robinhood.com'
    ]),
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
   * CLAIM_COOLDOWN in RobinPumpNFTStaking.sol so the lock picker can render
   * before the first RPC returns. staking.js overwrites them with the
   * authoritative values from lockBounds() as soon as the contract is read —
   * never treat these as the source of truth.
   */
  lockRules: Object.freeze({
    minSeconds: 7 * 86400,      // 7 days
    maxSeconds: 1095 * 86400,   // 3 years
    claimCooldownSeconds: 86400 // 24h per NFT
  }),
  /*
   * Selectors are derived at runtime by keccak-256 over these canonical
   * signatures (see SEL in staking.js). Copied verbatim from
   * robinpump-staking/frontend-abi/RobinPumpNFTStaking.json so the deployed ABI
   * can be diffed against what the frontend actually calls. One character of
   * drift changes the selector and every transaction would revert on-chain.
   */
  stakingAbiSignatures: Object.freeze([
    // Writes
    'stake(uint256,uint256)',
    'unstake(uint256)',
    'claim(uint256)',
    'claimBatch(uint256[])',
    /*
     * Withdraws the owedRewards credit that unstake() books when the pool was
     * short at settlement time. Without this the credit is stranded on-chain.
     */
    'claimOwed()',
    // Reads
    'getStakedTokenIds(address)',
    'getStakeInfo(uint256)',
    'rewardPerDay(uint256)',
    'rewardRateOf(address)',
    'claimableRewardOf(address)',
    'lockBounds()',
    /*
     * The live reward pool: rewardToken.balanceOf(stakingContract). claim()
     * reverts with InsufficientRewardPool when the settled amount exceeds this,
     * so the UI must read it and cap what it advertises as claimable.
     */
    'rewardTokenBalance()',
    'owedRewards(address)',
    /*
     * Rarity gate. _stake() reverts with TierNotConfigured(tokenId) when
     * _tierPlusOne[tokenId] == 0, and that revert happens BEFORE the NFT
     * transfer, so nothing can get stuck. The real cost to a holder is the
     * approve() transaction that ensureApproval() sends first: that one
     * succeeds and burns gas, then stake() reverts.
     *
     * Both of these are `view`, so reading them is a free eth_call with no
     * transaction. The UI reads them per refresh and disables Stake for any
     * id whose tier has not been written yet, so no holder ever pays approve
     * gas for a stake that cannot succeed.
     */
    'unconfiguredTokenIds(uint256[])',
    'isTierConfigured(uint256)'
  ]),
  // Intentionally null: do not invent a transaction target.
  stakingContract: null,
  rarityMapping: null,
  rewardPool: null
});
