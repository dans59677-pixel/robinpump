# RobinPump Green Flock NFT Staking

Production staking contracts, tests and deployment tooling for the **Green Flock** collection on **Robinhood Chain (chain id 4663)**.

Stakers deposit a Green Flock NFT into escrow and accrue `$ROBINPUMP` at a fixed per-day rate determined by that token's rarity tier. There is no multiplier, no lock, and no admin path that can move a staked NFT.

| Item | Value |
| --- | --- |
| Chain id | `4663` (deployment aborts on any other id) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| NFT collection | `0xbd00ce673b84be8022af8be0039c7a5af69724a9` |
| Token ids | `1` … `3333` |
| Reward token | `0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf` |
| Solidity | `0.8.24`, optimizer 200 runs, `evmVersion: paris` |
| OpenZeppelin | `5.1.0` |

`decimals()` is read from the live reward token at run time. No script and no test assumes 18.

---

## Layout

```
robinpump-staking/
  contracts/
    RobinPumpNFTStaking.sol       the only production contract
    mocks/MockERC20.sol           test-only, deployed at 6 decimals
    mocks/MockERC721.sol          test-only
  config/
    tiers.json                    daily rates as decimal STRINGS
    token-tiers.example.csv       tokenId,tier template for the rarity import
  scripts/
    lib/common.ts                 shared guards, IO, formatting
    deploy.ts                     deploy + write deployments/<network>.json
    configure-tiers.ts            push the 5 daily rates on-chain
    configure-tiers-from-csv.ts   push per-token rarity, resumable
    fund-rewards.ts               approve + fundRewards
    lock-rarity.ts                irreversible; double-gated
    verify.ts                     Blockscout source verification
    status.ts                     read-only readiness report
    export-abi.ts                 frontend-abi/RobinPumpNFTStaking.json
  test/
    RobinPumpNFTStaking.test.ts   full behavioural matrix
  deployments/                    created at deploy time
  frontend-abi/                   created by `npm run abi`
```

`deployments/` and `frontend-abi/` do not exist until the scripts that create them run.

---

## Setup

```bash
cd robinpump-staking
npm install
npm run compile
npm test
```

`compile` and `test` need no private key and no network. Only the `--network robinhood` scripts do.

### Environment

Copy `.env.example` to `.env` and fill it in. `.env` and `../pk.txt` are both git-ignored.

| Variable | Purpose |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | 32-byte hex key. Preferred. |
| `DEPLOYER_KEY_FILE` | Fallback path to a file holding the key. Defaults to `../pk.txt`. |
| `ROBINHOOD_RPC` | RPC override. Defaults to the mainnet endpoint above. |
| `NFT_CONTRACT_ADDRESS` | Green Flock collection. Constructor argument. |
| `REWARD_TOKEN_ADDRESS` | `$ROBINPUMP`. Constructor argument. |
| `STAKING_CONTRACT_ADDRESS` | Written by you after deploy; lets every admin script skip the deployments file. |
| `OWNER_ADDRESS` | Owner after deploy. Empty means the deployer. |
| `FUND_AMOUNT` | Human-readable amount for `fund:rewards`, e.g. `5000000`. |
| `BLOCKSCOUT_API_KEY` | Any non-empty string; Blockscout does not check it. |

The key is resolved at run time only. It is never written into source, and `resolveDeployerKey()` returns `null` rather than throwing so that `compile` and `test` work on a machine with no key at all.

---

## Rates and decimals

`config/tiers.json` holds whole-token-per-day rates as **strings**:

| Tier | Name | Per day |
| --- | --- | --- |
| 0 | Legendary | `1000` |
| 1 | Epic | `333.333333` |
| 2 | Rare | `111.111111` |
| 3 | Uncommon | `37.037037` |
| 4 | Common | `12.345679` |

`configure-tiers.ts` reads `decimals()` from the live token, converts each string with `parseUnits`, and sends integers. Solidity never sees a fractional value. If a rate in the config carries more precision than the token supports, `parseUnits` throws and the script stops before sending anything — that failure is intentional, not a bug to work around.

Accrual is `rewardPerDay * elapsedSeconds / 86400`, integer division, floored. A short stake on a low-rate tier can legitimately settle to zero.

---

## Deployment runbook

Run in this order. Every step is idempotent except `lock:rarity`.

```bash
npm run preflight             # 0. read-only: chain id, deployer address, native balance
npm run deploy:mainnet        # 1. deploy, writes deployments/robinhood.json
npm run configure:tiers       # 2. set the 5 daily rates
npm run configure:tiers:csv   # 3. set per-token rarity (resumable, chunks of 50)
npm run fund:rewards          # 4. approve + fundRewards
npm run status                # 5. read-only readiness report
npm run lock:rarity           # 6. IRREVERSIBLE — only after status says rarity is complete
npm run verify:contract       # 7. Blockscout verification
npm run abi                   # 8. export frontend-abi/RobinPumpNFTStaking.json
```

**Step 0** sends no transaction. Use it to confirm the resolved deployer address and that it has gas before spending anything.

**Step 1** aborts unless `eth_chainId` is `4663`, and refuses to run if either constructor address has no bytecode.

**Step 3** needs a real rarity report. `config/token-tiers.example.csv` is a template with a handful of illustrative rows; it is **not** the Green Flock rarity distribution. Supply the real `tokenId,tier` mapping for all 3333 ids. The script reads on-chain state first and skips ids already set correctly, so it can be re-run after an interruption or a partial rarity export.

**Step 5** prints a PASS / WARN / BLOCKED table and a final `NOT READY` / `USABLE` / `READY` verdict. Blocking items are: an external contract with no bytecode, a tier rate left at zero, incomplete rarity, and an empty reward pool. Warnings are: on-chain rates drifting from `config/tiers.json`, rarity not yet locked, and deposits paused.

**Step 6** requires `configuredCount == 3333` on-chain *and* `CONFIRM_LOCK_RARITY=YES` in the environment:

```bash
CONFIRM_LOCK_RARITY=YES npm run lock:rarity
```

After it lands, every rarity write reverts with `RarityAlreadyLocked` permanently. There is no unlock.

**Step 8** must run after `compile`, since it reads the Hardhat artifact.

### If every network step fails with `certificate has expired`

The RPC host is not reachable from the current machine. `rpc.mainnet.chain.robinhood.com` should resolve, via `customer-origin.offchainlabs.com`, to Cloudflare addresses. On a connection where the ISP intercepts DNS it instead resolves to a filtering host (`internetpositif.id`, `36.86.63.185`) that serves a certificate for an unrelated name, so TLS fails before any JSON-RPC call is made. Nothing in this project is at fault and no key or config change will help.

Confirm which case you are in:

```bash
# What the machine resolves
powershell -NoProfile -Command "Resolve-DnsName rpc.mainnet.chain.robinhood.com"

# What public DNS resolves
curl -sS -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=rpc.mainnet.chain.robinhood.com&type=A"
```

If the two disagree, switch to a resolver the ISP does not intercept (DNS-over-HTTPS or a VPN) and re-run `npm run preflight`. Do not work around it by disabling TLS verification: that would send the deployer key over a connection terminated by a third party.

---

## Frontend wiring

After a successful deploy, put the address the script actually printed into `.env` at the project root:

```
NEXT_PUBLIC_STAKING_CONTRACT_ADDRESS=0x…
```

Then set `stakingContract` and flip `enabled: true` in [`staking-config.js`](../staking-config.js:8), and copy the ABI from `frontend-abi/RobinPumpNFTStaking.json`.

Do not fill any of this in from a guess. The staking page reads these values directly and a wrong address produces silent read failures.

---

## Contract surface

Constants: `TIER_COUNT = 5`, `MIN_TOKEN_ID = 1`, `MAX_TOKEN_ID = 3333`, `TOTAL_SUPPLY = 3333`, `MAX_BATCH_SIZE = 50`, `REWARD_PERIOD = 1 days`.

**Staker functions** — [`stake()`](contracts/RobinPumpNFTStaking.sol:319), [`stakeBatch()`](contracts/RobinPumpNFTStaking.sol:324), [`claim()`](contracts/RobinPumpNFTStaking.sol:366), [`claimBatch()`](contracts/RobinPumpNFTStaking.sol:387), [`unstake()`](contracts/RobinPumpNFTStaking.sol:444), [`unstakeBatch()`](contracts/RobinPumpNFTStaking.sol:462), [`claimOwed()`](contracts/RobinPumpNFTStaking.sol:425).

**Views** — `pendingReward`, `pendingRewardOf`, `getStakeInfo`, `isStaked`, `stakerOf`, `getStakedTokenIds`, `stakedBalanceOf`, `tokenTier`, `isTierConfigured`, `getRewardRates`, `getTierCounts`, `unconfiguredTokenIds`, `rewardTokenBalance`.

**Owner functions** — `setTokenTier`, `setTokenTiers`, `lockRarity`, `setRewardRate`, `setRewardRates`, `fundRewards`, `pause`, `unpause`. That is the complete list; there is no withdraw, rescue, sweep, migrate or recover function anywhere in the ABI, and a test asserts this by reflecting over `interface.fragments`.

Security properties:

- `nftContract` and `rewardToken` are `immutable`. Neither can be repointed after deploy.
- Checks-effects-interactions throughout, plus `nonReentrant` on every state-changing external.
- `SafeERC20` for all token movement, with balance-delta accounting so a fee-on-transfer token cannot corrupt the pool figure.
- Batch settlement sums first and then makes **one** aggregate ERC-20 transfer. Two tests count the actual `Transfer` logs in the receipt to prove it.
- A tier-plus-one sentinel distinguishes "unset" from tier 0, so an unconfigured id can never be silently treated as Legendary. `stake()` reverts with `TierNotConfigured`.
- `onERC721Received` reverts with `DirectNftTransferNotAllowed`, so a raw `safeTransferFrom` cannot strand an NFT outside the accounting.
- Per-user id lists use swap-and-pop with a maintained index. A test removes a middle entry and then unstakes both survivors to prove index integrity.
- 18 custom errors, no revert strings.

---

## Two deliberate deviations from the literal spec

Both exist so that neither an administrator nor an empty reward pool can trap a user's NFT.

**1. `whenNotPaused` gates deposits only.** `stake` and `stakeBatch` are pausable; `claim`, `claimBatch`, `unstake`, `unstakeBatch` and `claimOwed` are not. A pause that also blocked withdrawal would let the owner hold user NFTs indefinitely, which is exactly the power the no-backdoor requirement is meant to remove.

**2. `unstake` defers instead of reverting when the pool is short.** If the reward pool cannot cover the settled amount, the unpaid remainder is recorded in `owedRewards[user]`, a `RewardDeferred` event is emitted, and the NFT still returns to its staker. The debt is claimable later via `claimOwed()` once the pool is refilled. Making `unstake` revert on an underfunded pool would mean a treasury oversight locks NFTs.

Explicit `claim()` still reverts with `InsufficientRewardPool` as specified — a claim that silently pays nothing would be worse than a clear failure.

---

## Changing a rate after launch

`setRewardRate` and `setRewardRates` reprice the **entire unsettled window**, not just the time after the change, because accrual is computed from a single `stakedAt` checkpoint rather than an accumulator. Lowering a rate retroactively reduces rewards already earned but not yet claimed.

To avoid that, have stakers claim first, or announce the change in advance. This is a documented property of the fixed-rate design, not a defect; an accumulator-based design would have avoided it at the cost of significantly more storage per stake.

---

## Tests

```bash
npm test
```

Roughly 50 cases across 11 groups: deployment, rarity configuration, `lockRarity`, reward rates, reward pool, staking, accrual, claiming, unstaking, pause, admin-cannot-take-user-NFTs, and accounting totals.

Design choices that matter:

- `MockERC20` is deployed at **6 decimals**, so any 18-decimal assumption anywhere in the stack fails a test rather than passing silently.
- `expectedReward()` reproduces the contract's floor division in `BigInt`. No assertion compares against a rounded or approximate figure.
- `stakeAt()` returns the real block timestamp of the stake transaction, and `time.setNextBlockTimestamp()` lands the next transaction on an exact target. Reward tests are not flaky by a second.
- Token id 3300 is minted to a staker but deliberately left unconfigured, to exercise `TierNotConfigured` against a genuinely owned token.
- The no-backdoor rule is an executable assertion, not a comment: the ABI is scanned for forbidden function names, and a companion test proves the owner can neither `transferFrom` an escrowed NFT (`ERC721InsufficientApproval`) nor `unstake` it (`NotStaker`).

One fixture writes all 3333 tier mappings to make `lockRarity()` reachable, which is why `hardhat.config.ts` sets `mocha.timeout` to 120 s.

---

## Notes

- `evmVersion` is pinned to `paris`. Robinhood Chain is an Arbitrum L2 and cancun opcodes are not assumed available.
- `bytecodeHash: 'none'` keeps builds reproducible for source verification.
- Never commit `.env` or `pk.txt`. Both are git-ignored; verify with `git check-ignore -v pk.txt` before any commit that touches the repository root.
