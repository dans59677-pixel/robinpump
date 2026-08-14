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
3. Audited staking contract address, deployed from `GreenFlockStaking.sol`, exposing the exact ABI the frontend calls (see "Locking rules and ABI surface" below).
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

- Use OpenZeppelin **v5** (`@openzeppelin/contracts@^5`): `token/ERC721/IERC721.sol`, `token/ERC20/utils/SafeERC20.sol`, `utils/ReentrancyGuard.sol`, `access/Ownable.sol`. Note v5 moved `ReentrancyGuard` from `security/` to `utils/` and made `Ownable` require an explicit `initialOwner` constructor argument. Mixing v4 paths will not compile.
- Validate the configured collection in every stake call; escrow with `safeTransferFrom`; reject duplicate stakes.
- Store `tokenId -> tier` (or a verified Merkle root/proof) on chain. The frontend must only display it.
- Store per-tier rates in integer token base units. With 18 decimals, `1000 ROBINPUMP/day` is `1000e18 / 86400` with a precision-safe remainder/accounting approach. Never calculate rewards from JavaScript floating point.
- Calculate accrual from `block.timestamp`, checkpoint before claim/unstake, update accounting before ERC-20 transfers, and defend against reentrancy.
- Transfer rewards only from a funded staking vault. Do not introduce a mint function unless the official token contract explicitly provides it and the project has the authority. The verified token is fixed supply.
- Gate tier/rate configuration with a tightly controlled admin/multisig and emit on-chain events for every change.

## Locking rules and ABI surface

Locking parameters, fixed as immutable constants in `GreenFlockStaking.sol`:

| Rule | Value | Constant |
| --- | --- | --- |
| Minimum lock | 7 days | `MIN_LOCK_DURATION` |
| Maximum lock | 1095 days (3 years) | `MAX_LOCK_DURATION` |
| Claim cooldown | 24 hours, **per NFT** | `CLAIM_COOLDOWN` |
| Early unstake | Forbidden outright — no penalty path, no emergency exit | `require(block.timestamp >= unlockAt)` in `unstake()` |
| Duration multiplier | None. The rate depends only on tier, so a longer lock earns more purely by accruing for longer. | — |

The frontend derives 4-byte selectors at runtime by hashing these canonical
signatures with its own keccak-256 (verified against known ABI selectors). The
deployed ABI must match them character for character, including parameter types
and the absence of spaces:

```text
stake(uint256,uint256)        // tokenId, lockDuration (seconds)
unstake(uint256)
claimReward(uint256)
claimAllRewards()
stakedTokenIds(address)       // -> uint256[]
stakeDetails(uint256)         // -> 11 static values, see below
rewardRateOf(address)         // -> uint256 tokens/second across the wallet
lockBounds()                  // -> (minLock, maxLock, claimCooldown)
```

`stakeDetails(tokenId)` must return exactly this order — the frontend decodes it
by word index, so inserting or reordering a field silently corrupts every
countdown:

```text
0  owner          address
1  tier           uint8
2  ratePerSecond  uint256
3  stakedAt       uint256
4  lockDuration   uint256
5  unlockAt       uint256
6  lastClaimAt    uint256
7  nextClaimAt    uint256
8  pending        uint256
9  accrued        uint256
10 checkpoint     uint256
```

The live reward counter mirrors `_pendingReward` client-side as
`accrued + (chainNow - checkpoint) * ratePerSecond`, where `chainNow` is anchored
to the latest block's `timestamp` rather than the browser clock. If the contract's
accrual formula changes, the ticker in `staking.js` must change with it or the
displayed figure will drift from the claimable amount.

Approval: the frontend calls per-token `approve()` rather than
`setApprovalForAll`, so the staking contract never holds blanket authority over a
user's wallet. It does check `isApprovedForAll` first and skips the approval if a
user has already granted it elsewhere.

## Rarity report gate

Before deployment, generate and commit these verified files from final metadata:

- `staking_rarity_report.json`
- `staking_rarity_report.csv` with `token_id,rarity,reward_per_day`

The report must contain exactly IDs 1 through 3333 once each. It must also calculate actual tier counts and maximum daily/monthly/yearly emissions. Reward rates are: Legendary 1000/day, Epic 333.333333/day, Rare 111.111111/day, Uncommon 37.037037/day, Common 12.345679/day. Do not produce the report until official metadata and tiers are supplied.

## Frontend activation checklist

Only after all inputs above are supplied and independently re-verified:

1. Set `stakingContract` in `staking-config.js` to the deployed address and flip `enabled` to `true`. Both gates must pass before any transaction path is exposed (`STAKING_ACTIVE` in `staking.js`). Also fill in `rarityMapping` and `rewardPool`.
2. Add an EVM wallet connector and use chain ID `4663`; use a production RPC provider rather than relying on the rate-limited public endpoint.
3. Read NFT ownership, staked status, reward state, and `ROBINPUMP` balances from the contract/RPC; wait for transaction receipts before marking a transaction successful.
4. Paginate token enumeration and use multicall/batching; never make 3333 serial RPC calls from the browser.
5. Enable controls only when the connected wallet, chain, collection, staking contract, and transaction preconditions validate.
6. Confirm `lockBounds()` returns the expected triple on the deployed contract. `lockRules` in `staking-config.js` is a pre-RPC display default only; if the deployed constants differ, the picker will briefly show the wrong bounds before the read lands.
7. Run signed end-to-end tests on the deployed contract: approve + stake at the 7-day minimum and the 1095-day maximum, a claim before the cooldown elapses (must be refused), a claim after it, an unstake attempt while locked (must be refused), an unstake after unlock, `claimAllRewards` with a mix of ready and cooling-down NFTs, and a rejected wallet signature.

**Frontend staking UI is ready, but real staking cannot be activated until `STAKING_CONTRACT_ADDRESS`, the Green Flock collection address, verified rarity mapping, and funded reward vault are deployed and configured.**

## Preview mode (`staking.html?demo=1`)

The staking UI can be demonstrated before the contract exists. Open `staking.html?demo=1` and the page renders a synthetic session: five Green Flock NFTs across all five tiers, three of them staked, with the live reward counter ticking and the lock modal fully operable.

Isolation from the live transaction path:

| Guard | Behaviour |
| --- | --- |
| `DEMO_MODE` | Derived **only** from the `demo=1` query parameter. It is never read from config, and never used as a fallback when a wallet or RPC is unavailable — a broken live page fails as a broken live page, it never degrades into the simulation. |
| `sendTx()` | Throws `Preview mode is active — no transaction can be signed.` on entry if `DEMO_MODE` is set. Reaching it means a demo branch leaked into the live layer; the throw is the backstop. |
| Wallet events | In demo mode no `accountsChanged` / `chainChanged` listener is registered and no passive reconnect runs, so a real account can never overwrite the synthetic session. |
| RPC | Every demo function resolves from local state. `refreshState()` returns before its first RPC, and the token-supply read is replaced by a static figure. |
| Config | `enabled` stays `false` and `stakingContract` stays `null`. `STAKING_ACTIVE` is unaffected; only `UI_STAKING_ENABLED` (`STAKING_ACTIVE \|\| DEMO_MODE`) opens the buttons. |
| Visibility | A persistent `#demoBanner` sits above the hero, the notice banner reads *Preview mode — synthetic data, no chain access*, the status line repeats it, the wallet chip reads *Preview (no wallet)*, and every toast is labelled `(preview)`. |

Simulated actions mutate only `demoRecords` and `demoBalance`: stake writes a record with the chosen lock term, unstake credits pending rewards and removes it, claim pays out and restarts the 24h cooldown, claim-all skips tokens still cooling down. Each runs through `runDemoTx()`, which mirrors `runTx()`'s toast sequence and single-flight lock with artificial latency.

The synthetic records are built to the exact shape `decodeStakeDetails()` returns — `BigInt` for `pending` / `accrued` / `ratePerSecond`, `Number` for every timestamp. Any deviation makes `localPending()` throw on mixed-type arithmetic once the 1-second ticker fires, so keep the shape in step if the contract's return tuple changes.

Preview mode is a presentation aid, not a test of the contract. It proves the UI wiring, not the on-chain accounting.

## Verification status of this implementation

- `staking.js` passes `node --check`. Its keccak-256 was verified against published digests for `''` and `'abc'` and against nine known ABI selectors, four of which (`balanceOf`, `totalSupply`, `name`, `tokenURI`) were already hardcoded in the file before the hash existed, making them independent oracles. The multi-block sponge path (inputs of 136 bytes or more) is **not** exercised by any test; every signature hashed here is far shorter, so this does not affect the selector table.
- Every `getElementById` in `staking.js` resolves to an ID present in `staking.html`, and every CSS class the JS emits has a matching rule in `staking.css` or `style.css`. Both were checked mechanically.
- `GreenFlockStaking.sol` has **not been compiled or tested.** There is no Solidity toolchain, `package.json`, or OpenZeppelin dependency tree in this repository. The OZ v5 migration and the reward-accounting fixes are reasoned, not compiler-verified. Compile it, run a test suite against the rules table above, and re-audit before deploying.
- Browser rendering was not exercised. The dashboard, live ticker, lock modal, and transaction flows have not been run against a wallet or a live chain.
- Demo mode was verified by loading `staking.js` under a stubbed DOM with `?demo=1` and asserting 34 checks: flag derivation (`DEMO_MODE` true, `STAKING_ACTIVE` still false), the synthetic dataset size, the `BigInt`/`Number` field types of every stake record, coverage of all four card states (locked, unlocked, claim-ready, cooling down), monotonic accrual in `localPending()`, `tickLiveValues()` and `buildNftCard()` running clean, `sendTx()` throwing on entry, and each simulated action mutating local state correctly. A static scan of the 250-line demo block confirms it calls no chain primitive. The harness was temporary and is not committed.
