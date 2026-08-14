# RobinPump Green Flock staking — deployment prerequisites

## Verified audit record (2026-08-14)

- The existing site is a static HTML/CSS/JavaScript landing page. It has no framework, package manifest, TypeScript, wallet connector, RPC configuration, backend, database, NFT integration, or deployment configuration in the repository.
- The RobinPump staking reward token is `0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf` on **Robinhood Chain mainnet** (chain ID `4663`), an Ethereum-compatible Arbitrum L2. The public RPC is `https://rpc.mainnet.chain.robinhood.com`; native gas is ETH; explorer is `https://robinhoodchain.blockscout.com`.
- The Pons launchpad and Robinhood Chain Blockscout verify the contract as `Robin Pump` / `ROBINPUMP`, an ERC-20 with 18 decimals and raw total supply `1000000000000000000000000000` (1,000,000,000 tokens). The source code is verified as `PonsV2LauncherToken`, built on OpenZeppelin ERC20 and ERC20Burnable; it supports the standard `balanceOf`, `transfer`, `approve`, and `transferFrom` interface.
- The entire initial supply was minted to the Pons bonding curve. This does **not** fund staking rewards. A separate staking reward vault must be funded deliberately.
- The landing page is aligned with this Robinhood Chain / Pons token. The historical Pump.fun/Solana mint is not used by staking or displayed as the active contract.
- No verified Green Flock NFT collection address, NFT standard/metadata, staking contract, rarity mapping, or reward vault was available in the source or live site. No NFT ownership or staking state can therefore be read safely.

## Required public inputs before activation

1. Green Flock collection contract address on Robinhood Chain, ERC-721/ERC-1155 standard, metadata URI(s), and evidence that token IDs 1–3333 exist.
2. Final rarity mapping for all 3333 tokens, generated from official final metadata and reviewed for duplicates/missing IDs.
3. Audited staking contract address and ABI with `stake`, `unstake`, `claimReward`, `pendingReward`, and wallet/token staking reads.
4. Reward vault address and on-chain proof of sufficient `ROBINPUMP` funding/allowance.
5. Explorer URL and signed test evidence for approval, stake, claim, unstake, rejected signature, and multiple NFTs.

## EVM contract architecture

```text
Green Flock ERC-721 collection
        |
        v
Staking contract (escrow + reward accounting)
        |                         |
        |                         +-- staked token ID, owner, tier, accrued checkpoint
        v
ROBINPUMP ERC-20 reward vault --> holder wallet
```

Contract requirements:

- Use OpenZeppelin `IERC721`, `SafeERC20`, `ReentrancyGuard`, and `Ownable`/`AccessControl`.
- Validate the configured collection in every stake call; escrow with `safeTransferFrom`; reject duplicate stakes.
- Store `tokenId -> tier` (or a verified Merkle root/proof) on chain. The frontend must only display it.
- Store per-tier rates in integer token base units. With 18 decimals, `1000 ROBINPUMP/day` is `1000e18 / 86400` with a precision-safe remainder/accounting approach. Never calculate rewards from JavaScript floating point.
- Calculate accrual from `block.timestamp`, checkpoint before claim/unstake, update accounting before ERC-20 transfers, and defend against reentrancy.
- Transfer rewards only from a funded staking vault. Do not introduce a mint function unless the official token contract explicitly provides it and the project has the authority. The verified token is fixed supply.
- Gate tier/rate configuration with a tightly controlled admin/multisig and emit on-chain events for every change.

## Rarity report gate

Before deployment, generate and commit these verified files from final metadata:

- `staking_rarity_report.json`
- `staking_rarity_report.csv` with `token_id,rarity,reward_per_day`

The report must contain exactly IDs 1 through 3333 once each. It must also calculate actual tier counts and maximum daily/monthly/yearly emissions. Reward rates are: Legendary 1000/day, Epic 333.333333/day, Rare 111.111111/day, Uncommon 37.037037/day, Common 12.345679/day. Do not produce the report until official metadata and tiers are supplied.

## Frontend activation checklist

Only after all inputs above are supplied and independently re-verified:

1. Replace the null collection/staking/rate/vault fields in `staking-config.js` with verified values.
2. Add an EVM wallet connector and use chain ID `4663`; use a production RPC provider rather than relying on the rate-limited public endpoint.
3. Read NFT ownership, staked status, reward state, and `ROBINPUMP` balances from the contract/RPC; wait for transaction receipts before marking a transaction successful.
4. Paginate token enumeration and use multicall/batching; never make 3333 serial RPC calls from the browser.
5. Enable controls only when the connected wallet, chain, collection, staking contract, and transaction preconditions validate.

**Frontend staking UI is ready, but real staking cannot be activated until `STAKING_CONTRACT_ADDRESS`, the Green Flock collection address, verified rarity mapping, and funded reward vault are deployed and configured.**
