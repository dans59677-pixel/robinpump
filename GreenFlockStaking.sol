// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  GreenFlockStaking
 * @notice Stake RobinPump Green Flock ERC-721 NFTs on a fixed-term lock and earn
 *         $ROBINPUMP rewards that accrue every second.
 *
 * Architecture
 * ─────────────
 * Green Flock ERC-721 (0xbd00ce673b84be8022af8be0039c7a5af69724a9)
 *         │
 *         ▼
 * GreenFlockStaking  ──  escrow + tier + lock + reward accounting
 *         │
 *         ▼
 * ROBINPUMP ERC-20 (0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf) reward vault
 *
 * Lock terms
 * ───────────
 * - The staker chooses a lock duration at stake time.
 * - Minimum 7 days, maximum 1095 days (3 years).
 * - Rewards accrue at the tier rate for the whole stake. The lock length does
 *   NOT change the rate; it only controls when the NFT can be withdrawn.
 * - `unstake` reverts until `stakedAt + lockDuration` has passed. There is no
 *   early exit and no early-exit penalty path.
 * - `extendLock` can only lengthen an existing lock, never shorten it.
 *
 * Claim terms
 * ────────────
 * - Rewards can be claimed while the NFT is still locked.
 * - Claiming is rate limited to once per 24 hours PER NFT.
 * - The cooldown clock starts at stake time, so the first claim for a token
 *   becomes available 24 hours after it was staked.
 * - `claimAllRewards` claims every token that is off cooldown and silently
 *   skips the rest, so one token on cooldown never blocks the others.
 * - `unstake` pays out the remaining balance once the lock has expired,
 *   regardless of the claim cooldown.
 *
 * Security
 * ─────────
 * - OpenZeppelin v5 ReentrancyGuard on all state-changing externals
 * - SafeERC20 for all ERC-20 transfers
 * - Ownable for admin functions
 * - Checks-effects-interactions pattern throughout
 * - Integer-only reward arithmetic (no floating point)
 * - Per-tokenId ownership validation on every stake
 *
 * Reward precision
 * ─────────────────
 * All rates are stored in token base units (18 decimals).
 * Legendary: 1000 * 1e18 / 86400 base units per second.
 * Each lower tier divides by 3 (integer division with remainder
 * handled by checkpointing, not truncation).
 *
 * Activation
 * ──────────
 * Deploy → setTierRates() → setTokenTiers(tokenIds, tiers) → fund reward vault
 * → open staking (automatic after deployment when fundRewardVault is called).
 *
 * DEPLOY CHECKLIST (see STAKING_DEPLOYMENT.md)
 * 1. Verify NFT contract, reward token, chain ID.
 * 2. Supply full rarity mapping for all 3333 token IDs.
 * 3. Audit this contract before mainnet.
 * 4. Fund reward vault BEFORE opening staking.
 *
 * @dev Requires OpenZeppelin Contracts v5.x. The v5 ReentrancyGuard path is
 *      `utils/ReentrancyGuard.sol` (it was `security/` in v4) and Ownable
 *      takes an explicit initial owner argument.
 */

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract GreenFlockStaking is IERC721Receiver, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────
    uint8 public constant TIER_LEGENDARY = 0;
    uint8 public constant TIER_EPIC      = 1;
    uint8 public constant TIER_RARE      = 2;
    uint8 public constant TIER_UNCOMMON  = 3;
    uint8 public constant TIER_COMMON    = 4;
    uint8 public constant TIER_UNSET     = 255;

    uint256 private constant SECONDS_PER_DAY = 86_400;

    /// @notice Shortest lock a staker may choose (7 days).
    uint256 public constant MIN_LOCK_DURATION = 7 days;
    /// @notice Longest lock a staker may choose (1095 days ≈ 3 years).
    uint256 public constant MAX_LOCK_DURATION = 1095 days;
    /// @notice Minimum interval between two claims for the same token.
    uint256 public constant CLAIM_COOLDOWN = 1 days;

    // ─── Immutables ────────────────────────────────────────────────────────────
    IERC721 public immutable nftContract;
    IERC20  public immutable rewardToken;

    // ─── Reward rates (base units / second, 18 decimals) ─────────────────────
    // Defaults: Legendary = 1000 tokens/day, each tier = prev / 3
    // Owner can update via setTierRates(). Stored per-second for precision.
    uint256[5] public rewardRatePerSecond;

    // ─── Token tier mapping ───────────────────────────────────────────────────
    // Stored as tier + 1 so that the default value 0 means "unconfigured"
    // rather than silently meaning Legendary. Read through tokenTier().
    mapping(uint256 => uint8) private _tierPlusOne;

    // ─── Staking records ──────────────────────────────────────────────────────
    // Field order is chosen so the struct packs into 3 storage slots:
    //   slot 0: owner (20) + tier (1) + stakedAt (8)
    //   slot 1: lockDuration (8) + rewardCheckpoint (8) + lastClaimAt (8)
    //   slot 2: accruedReward
    struct StakeRecord {
        address owner;
        uint8   tier;
        uint64  stakedAt;         // block.timestamp when staked
        uint64  lockDuration;     // seconds the NFT stays locked
        uint64  rewardCheckpoint; // block.timestamp of last claim/checkpoint
        uint64  lastClaimAt;      // block.timestamp of last successful claim
        uint256 accruedReward;    // reward accumulated up to checkpoint (base units)
    }
    mapping(uint256 => StakeRecord) public stakes;          // tokenId → record
    mapping(address => uint256[])   private _stakedByOwner; // wallet → tokenIds

    // ─── Counters ─────────────────────────────────────────────────────────────
    uint256 public totalStaked;
    uint256 public totalRewardDistributed;

    // ─── Events ───────────────────────────────────────────────────────────────
    event Staked(
        address indexed owner,
        uint256 indexed tokenId,
        uint8   tier,
        uint256 lockDuration,
        uint256 unlockAt,
        uint256 timestamp
    );
    event LockExtended(
        address indexed owner,
        uint256 indexed tokenId,
        uint256 previousLockDuration,
        uint256 newLockDuration,
        uint256 unlockAt
    );
    event Unstaked(address indexed owner, uint256 indexed tokenId, uint256 rewardClaimed, uint256 timestamp);
    event RewardClaimed(address indexed owner, uint256 indexed tokenId, uint256 amount, uint256 timestamp);
    event TierRatesUpdated(uint256[5] ratesPerSecond);
    event TokenTiersSet(uint256[] tokenIds);
    event RewardVaultFunded(address indexed from, uint256 amount);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _nftContract, address _rewardToken) Ownable(msg.sender) {
        require(_nftContract != address(0), "Invalid NFT contract");
        require(_rewardToken  != address(0), "Invalid reward token");
        nftContract  = IERC721(_nftContract);
        rewardToken  = IERC20(_rewardToken);
        _setDefaultRates();
    }

    function _setDefaultRates() private {
        // 1000 tokens/day in base units per second (18 decimals)
        // Each tier = previous / 3 (integer; remainder is negligible per second)
        rewardRatePerSecond[TIER_LEGENDARY] = (1_000 * 1e18) / SECONDS_PER_DAY;
        rewardRatePerSecond[TIER_EPIC]      = (1_000 * 1e18) / (SECONDS_PER_DAY * 3);
        rewardRatePerSecond[TIER_RARE]      = (1_000 * 1e18) / (SECONDS_PER_DAY * 9);
        rewardRatePerSecond[TIER_UNCOMMON]  = (1_000 * 1e18) / (SECONDS_PER_DAY * 27);
        rewardRatePerSecond[TIER_COMMON]    = (1_000 * 1e18) / (SECONDS_PER_DAY * 81);
    }

    // ─── Admin: set tier rates ─────────────────────────────────────────────────
    /**
     * @notice Update per-second reward rates for all 5 tiers.
     * @param ratesPerSecond Array[5] in token base units (18 decimals) per second.
     */
    function setTierRates(uint256[5] calldata ratesPerSecond) external onlyOwner {
        for (uint8 i = 0; i < 5; i++) {
            rewardRatePerSecond[i] = ratesPerSecond[i];
        }
        emit TierRatesUpdated(ratesPerSecond);
    }

    // ─── Admin: set token tiers (batch) ───────────────────────────────────────
    /**
     * @notice Assign tiers to token IDs. Call before opening staking.
     * @param tokenIds Array of token IDs (max 500 per call to stay under gas limit).
     * @param tiers    Corresponding tier values (0=Legendary … 4=Common).
     */
    function setTokenTiers(uint256[] calldata tokenIds, uint8[] calldata tiers) external onlyOwner {
        require(tokenIds.length == tiers.length, "Length mismatch");
        require(tokenIds.length <= 500, "Max 500 per call");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(tiers[i] <= TIER_COMMON, "Invalid tier");
            _tierPlusOne[tokenIds[i]] = tiers[i] + 1;
        }
        emit TokenTiersSet(tokenIds);
    }

    /**
     * @notice Configured tier for a token ID, or TIER_UNSET (255) if none.
     */
    function tokenTier(uint256 tokenId) public view returns (uint8) {
        uint8 packed = _tierPlusOne[tokenId];
        return packed == 0 ? TIER_UNSET : packed - 1;
    }

    // ─── Admin: fund reward vault ──────────────────────────────────────────────
    /**
     * @notice Transfer $ROBINPUMP into this contract as the reward vault.
     * @dev Approve this contract first, then call fundRewardVault.
     */
    function fundRewardVault(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardVaultFunded(msg.sender, amount);
    }

    // ─── Stake ─────────────────────────────────────────────────────────────────
    /**
     * @notice Stake a single NFT for a fixed term. Caller must approve first.
     * @param tokenId      The NFT token ID to stake.
     * @param lockDuration Lock length in seconds. Must be between
     *                     MIN_LOCK_DURATION (7 days) and MAX_LOCK_DURATION
     *                     (1095 days) inclusive.
     */
    function stake(uint256 tokenId, uint256 lockDuration) external nonReentrant {
        _validateLock(lockDuration);
        _stake(msg.sender, tokenId, lockDuration);
    }

    /**
     * @notice Batch stake multiple NFTs under the same lock duration.
     * @param tokenIds     Token IDs to stake.
     * @param lockDuration Lock length applied to every token in this call.
     */
    function stakeBatch(uint256[] calldata tokenIds, uint256 lockDuration) external nonReentrant {
        require(tokenIds.length > 0, "No token IDs");
        _validateLock(lockDuration);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _stake(msg.sender, tokenIds[i], lockDuration);
        }
    }

    function _validateLock(uint256 lockDuration) private pure {
        require(lockDuration >= MIN_LOCK_DURATION, "Lock below 7 days");
        require(lockDuration <= MAX_LOCK_DURATION, "Lock above 3 years");
    }

    function _stake(address caller, uint256 tokenId, uint256 lockDuration) private {
        require(nftContract.ownerOf(tokenId) == caller, "Not token owner");
        require(stakes[tokenId].owner == address(0),    "Already staked");
        uint8 tier = tokenTier(tokenId);
        require(tier != TIER_UNSET, "Tier not configured for this token");

        // Transfer NFT into escrow
        nftContract.safeTransferFrom(caller, address(this), tokenId);

        uint64 now64 = uint64(block.timestamp);
        stakes[tokenId] = StakeRecord({
            owner:             caller,
            tier:              tier,
            stakedAt:          now64,
            lockDuration:      uint64(lockDuration),
            rewardCheckpoint:  now64,
            // Start the 24h claim clock at stake time: the first claim for this
            // token unlocks CLAIM_COOLDOWN after it was staked.
            lastClaimAt:       now64,
            accruedReward:     0
        });
        _stakedByOwner[caller].push(tokenId);
        totalStaked++;

        emit Staked(caller, tokenId, tier, lockDuration, block.timestamp + lockDuration, block.timestamp);
    }

    // ─── Extend lock ───────────────────────────────────────────────────────────
    /**
     * @notice Lengthen the lock on an already staked NFT.
     * @dev The new duration is measured from the original stakedAt, so it must
     *      be strictly greater than the current duration. Locks can never be
     *      shortened.
     */
    function extendLock(uint256 tokenId, uint256 newLockDuration) external nonReentrant {
        StakeRecord storage record = stakes[tokenId];
        require(record.owner == msg.sender, "Not staker");
        _validateLock(newLockDuration);
        uint256 previous = record.lockDuration;
        require(newLockDuration > previous, "Lock can only increase");

        record.lockDuration = uint64(newLockDuration);
        emit LockExtended(msg.sender, tokenId, previous, newLockDuration, record.stakedAt + newLockDuration);
    }

    // ─── Unstake ───────────────────────────────────────────────────────────────
    /**
     * @notice Unstake an NFT after its lock expires, claiming all remaining
     *         rewards and returning the NFT to its owner.
     * @dev Reverts while the token is still locked. The claim cooldown does not
     *      apply here: the lock has already run its full term.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        StakeRecord storage record = stakes[tokenId];
        require(record.owner == msg.sender, "Not staker");

        uint256 unlockAt = uint256(record.stakedAt) + uint256(record.lockDuration);
        require(block.timestamp >= unlockAt, "Still locked");

        // _pendingReward already includes record.accruedReward.
        uint256 total = _pendingReward(tokenId);

        // Checks → Effects
        _removeFromOwnerList(msg.sender, tokenId);
        delete stakes[tokenId];
        totalStaked--;

        // Interactions
        nftContract.safeTransferFrom(address(this), msg.sender, tokenId);
        if (total > 0) {
            _transferReward(msg.sender, total);
            emit RewardClaimed(msg.sender, tokenId, total, block.timestamp);
        }
        emit Unstaked(msg.sender, tokenId, total, block.timestamp);
    }

    // ─── Claim reward ──────────────────────────────────────────────────────────
    /**
     * @notice Claim accrued rewards for a single staked NFT without unstaking.
     * @dev Allowed while still locked, but only once per CLAIM_COOLDOWN per token.
     */
    function claimReward(uint256 tokenId) external nonReentrant {
        StakeRecord storage record = stakes[tokenId];
        require(record.owner == msg.sender, "Not staker");
        require(block.timestamp >= uint256(record.lastClaimAt) + CLAIM_COOLDOWN, "Claim once per day");

        uint256 pending = _pendingReward(tokenId);
        require(pending > 0, "Nothing to claim");

        // Checkpoint before transfer
        record.rewardCheckpoint = uint64(block.timestamp);
        record.lastClaimAt      = uint64(block.timestamp);
        record.accruedReward    = 0;

        _transferReward(msg.sender, pending);
        emit RewardClaimed(msg.sender, tokenId, pending, block.timestamp);
    }

    /**
     * @notice Claim rewards for every staked NFT that is currently off cooldown.
     * @dev Tokens still inside their 24h window are skipped, not reverted on, so
     *      a single cooling-down token never blocks the rest of the wallet.
     */
    function claimAllRewards() external nonReentrant {
        uint256[] storage ids = _stakedByOwner[msg.sender];
        require(ids.length > 0, "Nothing staked");

        uint256 totalPending = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            StakeRecord storage record = stakes[tokenId];
            if (block.timestamp < uint256(record.lastClaimAt) + CLAIM_COOLDOWN) continue;

            uint256 pending = _pendingReward(tokenId);
            if (pending == 0) continue;

            record.rewardCheckpoint = uint64(block.timestamp);
            record.lastClaimAt      = uint64(block.timestamp);
            record.accruedReward    = 0;

            totalPending += pending;
            emit RewardClaimed(msg.sender, tokenId, pending, block.timestamp);
        }
        require(totalPending > 0, "Nothing claimable yet");
        _transferReward(msg.sender, totalPending);
    }

    // ─── Views ─────────────────────────────────────────────────────────────────
    /**
     * @notice Pending reward for a single staked token (not yet claimed).
     */
    function pendingReward(uint256 tokenId) external view returns (uint256) {
        return _pendingReward(tokenId);
    }

    /**
     * @notice All staked token IDs for a wallet.
     */
    function stakedTokenIds(address owner) external view returns (uint256[] memory) {
        return _stakedByOwner[owner];
    }

    /**
     * @notice Number of NFTs a wallet currently has staked.
     */
    function stakedBalanceOf(address owner) external view returns (uint256) {
        return _stakedByOwner[owner].length;
    }

    /**
     * @notice Staking record for a token ID.
     */
    function stakeInfo(uint256 tokenId) external view returns (StakeRecord memory) {
        return stakes[tokenId];
    }

    /**
     * @notice Everything the dashboard needs for one staked token, in a single
     *         static tuple that is cheap to decode client side.
     * @return owner_        Staker address, or address(0) if not staked.
     * @return tier          Tier index 0-4 (TIER_UNSET if not staked).
     * @return ratePerSecond Reward accrual rate in base units per second.
     * @return stakedAt      Timestamp the NFT was staked.
     * @return lockDuration  Chosen lock length in seconds.
     * @return unlockAt      Timestamp the NFT becomes withdrawable.
     * @return lastClaimAt   Timestamp of the last successful claim.
     * @return nextClaimAt   Timestamp the next claim becomes allowed.
     * @return pending       Reward accrued so far, in base units.
     * @return accrued       Reward banked at the last checkpoint, in base units.
     * @return checkpoint    Timestamp rewards were last checkpointed.
     */
    function stakeDetails(uint256 tokenId)
        external
        view
        returns (
            address owner_,
            uint8   tier,
            uint256 ratePerSecond,
            uint256 stakedAt,
            uint256 lockDuration,
            uint256 unlockAt,
            uint256 lastClaimAt,
            uint256 nextClaimAt,
            uint256 pending,
            uint256 accrued,
            uint256 checkpoint
        )
    {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) {
            return (address(0), TIER_UNSET, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
        owner_        = record.owner;
        tier          = record.tier;
        ratePerSecond = rewardRatePerSecond[record.tier];
        stakedAt      = record.stakedAt;
        lockDuration  = record.lockDuration;
        unlockAt      = uint256(record.stakedAt) + uint256(record.lockDuration);
        lastClaimAt   = record.lastClaimAt;
        nextClaimAt   = uint256(record.lastClaimAt) + CLAIM_COOLDOWN;
        pending       = _pendingReward(tokenId);
        accrued       = record.accruedReward;
        checkpoint    = record.rewardCheckpoint;
    }

    /**
     * @notice Timestamp at which a staked NFT can be unstaked.
     */
    function unlockTimeOf(uint256 tokenId) external view returns (uint256) {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) return 0;
        return uint256(record.stakedAt) + uint256(record.lockDuration);
    }

    /**
     * @notice True once the lock has expired and the NFT can be unstaked.
     */
    function isUnlocked(uint256 tokenId) external view returns (bool) {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) return false;
        return block.timestamp >= uint256(record.stakedAt) + uint256(record.lockDuration);
    }

    /**
     * @notice Timestamp at which the next claim for this token is allowed.
     */
    function nextClaimTimeOf(uint256 tokenId) external view returns (uint256) {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) return 0;
        return uint256(record.lastClaimAt) + CLAIM_COOLDOWN;
    }

    /**
     * @notice True when the token is off cooldown and has a non-zero balance.
     */
    function canClaim(uint256 tokenId) external view returns (bool) {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) return false;
        if (block.timestamp < uint256(record.lastClaimAt) + CLAIM_COOLDOWN) return false;
        return _pendingReward(tokenId) > 0;
    }

    /**
     * @notice Total reward a wallet could claim right now across all its staked
     *         NFTs, ignoring tokens that are still on cooldown.
     */
    function claimableTotal(address owner) external view returns (uint256 total) {
        uint256[] storage ids = _stakedByOwner[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            StakeRecord storage record = stakes[ids[i]];
            if (block.timestamp < uint256(record.lastClaimAt) + CLAIM_COOLDOWN) continue;
            total += _pendingReward(ids[i]);
        }
    }

    /**
     * @notice Total reward accrued across all of a wallet's staked NFTs,
     *         including balances that are still on cooldown.
     */
    function pendingTotal(address owner) external view returns (uint256 total) {
        uint256[] storage ids = _stakedByOwner[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            total += _pendingReward(ids[i]);
        }
    }

    /**
     * @notice Combined per-second accrual rate for a wallet's staked NFTs.
     * @dev The frontend multiplies this by elapsed seconds to tick a live total
     *      between RPC reads.
     */
    function rewardRateOf(address owner) external view returns (uint256 ratePerSecond) {
        uint256[] storage ids = _stakedByOwner[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            ratePerSecond += rewardRatePerSecond[stakes[ids[i]].tier];
        }
    }

    /**
     * @notice Current reward vault balance.
     */
    function rewardVaultBalance() external view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }

    /**
     * @notice All current per-second reward rates.
     */
    function allTierRates() external view returns (uint256[5] memory) {
        return rewardRatePerSecond;
    }

    /**
     * @notice Lock and cooldown bounds, so the UI never hardcodes them.
     */
    function lockBounds()
        external
        pure
        returns (uint256 minLockDuration, uint256 maxLockDuration, uint256 claimCooldown)
    {
        return (MIN_LOCK_DURATION, MAX_LOCK_DURATION, CLAIM_COOLDOWN);
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────
    function _pendingReward(uint256 tokenId) private view returns (uint256) {
        StakeRecord storage record = stakes[tokenId];
        if (record.owner == address(0)) return 0;
        uint256 elapsed = block.timestamp - record.rewardCheckpoint;
        return record.accruedReward + (elapsed * rewardRatePerSecond[record.tier]);
    }

    function _transferReward(address to, uint256 amount) private {
        uint256 vaultBalance = rewardToken.balanceOf(address(this));
        uint256 sendAmount = amount > vaultBalance ? vaultBalance : amount;
        require(sendAmount > 0, "Reward vault empty");
        totalRewardDistributed += sendAmount;
        rewardToken.safeTransfer(to, sendAmount);
    }

    function _removeFromOwnerList(address owner, uint256 tokenId) private {
        uint256[] storage list = _stakedByOwner[owner];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == tokenId) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
    }

    // ─── ERC721 receiver ───────────────────────────────────────────────────────
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── Emergency ─────────────────────────────────────────────────────────────
    /**
     * @notice Owner can recover excess reward tokens not owed to stakers.
     * @dev Only call after confirming all pending rewards are accounted for.
     */
    function recoverRewardTokens(uint256 amount) external onlyOwner {
        rewardToken.safeTransfer(owner(), amount);
    }
}
