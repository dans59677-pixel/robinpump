// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RobinPumpNFTStaking
 * @notice Non-custodial staking for the RobinPump Green Flock ERC-721 collection,
 *         paying a fixed per-tier daily rate in $ROBINPUMP.
 *
 * Design constraints enforced by this contract:
 *
 *  - The NFT and reward token addresses are immutable. They can never be
 *    repointed after deployment.
 *  - Every stake commits to a lock duration between {MIN_LOCK_DURATION}
 *    (7 days) and {MAX_LOCK_DURATION} (3 years), chosen by the staker at
 *    deposit time. {unstake} before that window closes is forbidden outright:
 *    there is no early exit, no penalty path, and no admin override.
 *  - Reward may be claimed at most once every {CLAIM_COOLDOWN} (24 hours) per
 *    NFT. Accrual itself is continuous, so a cooldown never destroys reward;
 *    it only defers when the transfer may happen.
 *  - A token cannot be staked until its rarity tier has been configured.
 *    There is no default tier, so a misconfiguration can never silently pay
 *    out at the Legendary rate.
 *  - Rarity is permanently freezable via {lockRarity}. After that, every tier
 *    write reverts.
 *  - The owner has no path to move a staked NFT. Only the address that staked
 *    a token can withdraw it. There is no sweep, rescue, or admin-withdraw
 *    function for the collection.
 *  - {pause} gates new deposits only. Claiming and unstaking stay open while
 *    paused so the owner can never trap a user's NFT.
 *  - Rewards are paid from a pre-funded pool; this contract never mints.
 *    If the pool is short on an explicit {claim}, the call reverts rather than
 *    paying part of what is owed. On {unstake} the shortfall is instead
 *    recorded as a credit (see {owedRewards}) so an empty pool can never block
 *    the return of an NFT.
 *
 * Reward math is integer-only:
 *
 *      reward = rewardPerDay[tier] * (block.timestamp - lastClaimAt) / 1 days
 *
 * `rewardPerDay` is denominated in the reward token's smallest unit. The
 * deployment scripts read `decimals()` from the ERC-20 and convert the
 * human-readable rates, so no fractional arithmetic happens on-chain.
 */
contract RobinPumpNFTStaking is ERC721Holder, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Number of rarity tiers. 0 = Legendary … 4 = Common.
    uint8 public constant TIER_COUNT = 5;

    /// @notice Lowest valid Green Flock token id.
    uint256 public constant MIN_TOKEN_ID = 1;

    /// @notice Highest valid Green Flock token id.
    uint256 public constant MAX_TOKEN_ID = 3333;

    /// @notice Total ids that must be mapped before rarity can be locked.
    uint256 public constant TOTAL_SUPPLY = MAX_TOKEN_ID - MIN_TOKEN_ID + 1;

    /// @notice Upper bound on any array argument, to keep calls inside the gas limit.
    uint256 public constant MAX_BATCH_SIZE = 50;

    /// @notice Accrual period. Rates are quoted per day.
    uint256 public constant REWARD_PERIOD = 1 days;

    /// @notice Shortest lock a staker may commit to.
    uint256 public constant MIN_LOCK_DURATION = 7 days;

    /// @notice Longest lock a staker may commit to (3 years).
    uint256 public constant MAX_LOCK_DURATION = 1095 days;

    /// @notice Minimum spacing between two claims on the same NFT.
    uint256 public constant CLAIM_COOLDOWN = 24 hours;

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable configuration
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The Green Flock ERC-721 collection accepted by this contract.
    IERC721 public immutable nftContract;

    /// @notice The ERC-20 paid out as rewards ($ROBINPUMP).
    IERC20 public immutable rewardToken;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Two storage slots.
     *
     *      Slot 0: owner (160) + tier (8) + stakedAt (64) = 232 bits.
     *      Slot 1: lastClaimAt (64) + lockDuration (64)   = 128 bits.
     *
     *      `stakedAt` is written once at deposit and never moves: it anchors
     *      the lock (`unlockAt = stakedAt + lockDuration`) and is what the UI
     *      shows as "staked since".
     *
     *      `lastClaimAt` is the accrual checkpoint *and* the cooldown anchor.
     *      It starts at `stakedAt` and is advanced to `block.timestamp` on
     *      every settlement, so pending reward is always measured from the
     *      last payout and the 24h cooldown is measured from the same instant.
     *      One field serves both roles because a settlement is exactly the
     *      moment a claim becomes the new baseline.
     */
    struct StakeInfo {
        address owner;
        uint8 tier;
        uint64 stakedAt;
        uint64 lastClaimAt;
        uint64 lockDuration;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Active stake record per token id. `owner == address(0)` means not staked.
    mapping(uint256 => StakeInfo) public stakes;

    /// @dev Tier + 1, so that an unset entry (0) is distinguishable from tier 0
    ///      (Legendary). Read through {tokenTier} / {isTierConfigured}.
    mapping(uint256 => uint8) private _tierPlusOne;

    /// @notice Reward per day per tier, in reward-token base units.
    uint256[TIER_COUNT] public rewardPerDay;

    /// @notice Number of token ids that have a tier assigned.
    uint256 public configuredCount;

    /// @notice How many ids are assigned to each tier.
    uint256[TIER_COUNT] public tierCount;

    /// @notice Once true, every rarity write reverts permanently.
    bool public rarityLocked;

    /// @notice Number of NFTs currently held in escrow.
    uint256 public totalStaked;

    /// @notice Rewards earned but not paid because the pool was short at unstake time.
    mapping(address => uint256) public owedRewards;

    /// @notice Lifetime rewards paid out, for accounting/monitoring.
    uint256 public totalRewardsPaid;

    /// @dev Per-user list of staked ids, with an index for O(1) removal.
    mapping(address => uint256[]) private _stakedTokens;
    mapping(uint256 => uint256) private _stakedTokenIndex;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event Staked(
        address indexed user,
        uint256 indexed tokenId,
        uint8 tier,
        uint256 lockDuration,
        uint256 unlockAt,
        uint256 timestamp
    );
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 rewardPaid, uint256 timestamp);
    event RewardClaimed(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 timestamp);
    event RewardBatchClaimed(address indexed user, uint256 tokenCount, uint256 totalAmount);
    event RewardDeferred(address indexed user, uint256 indexed tokenId, uint256 amount);
    event OwedRewardPaid(address indexed user, uint256 amount);
    event TierAssigned(uint256 indexed tokenId, uint8 tier);
    event RewardRateUpdated(uint8 indexed tier, uint256 oldRewardPerDay, uint256 newRewardPerDay);
    event RarityLocked(uint256 configuredCount, uint256 timestamp);
    event RewardsFunded(address indexed from, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidTokenId(uint256 tokenId);
    error InvalidTier(uint8 tier);
    error TierNotConfigured(uint256 tokenId);
    error RewardRateNotSet(uint8 tier);
    error AlreadyStaked(uint256 tokenId);
    error NotStaked(uint256 tokenId);
    error NotStaker(uint256 tokenId, address caller);
    error NotTokenOwner(uint256 tokenId, address caller);
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 maxSize);
    error RarityAlreadyLocked();
    error RarityIncomplete(uint256 configured, uint256 required);
    error LengthMismatch(uint256 tokenIdsLength, uint256 tiersLength);
    error InsufficientRewardPool(uint256 required, uint256 available);
    error NothingOwed();
    error ZeroAmount();
    error DirectNftTransferNotAllowed();
    error InvalidLockDuration(uint256 provided, uint256 minDuration, uint256 maxDuration);
    error StakeLocked(uint256 tokenId, uint256 unlockAt);
    error ClaimCooldownActive(uint256 tokenId, uint256 nextClaimAt);

    // ─────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param nft            Green Flock ERC-721 address.
     * @param reward         $ROBINPUMP ERC-20 address.
     * @param initialOwner   Contract owner (admin).
     * @param ratesPerDay    Per-tier daily rate in reward-token base units,
     *                       indexed 0 = Legendary … 4 = Common.
     */
    constructor(
        address nft,
        address reward,
        address initialOwner,
        uint256[TIER_COUNT] memory ratesPerDay
    ) Ownable(initialOwner) {
        if (nft == address(0) || reward == address(0)) revert ZeroAddress();

        nftContract = IERC721(nft);
        rewardToken = IERC20(reward);

        for (uint8 t = 0; t < TIER_COUNT; ++t) {
            rewardPerDay[t] = ratesPerDay[t];
            emit RewardRateUpdated(t, 0, ratesPerDay[t]);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rarity configuration (admin)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Assign the rarity tier of a single token id.
    function setTokenTier(uint256 tokenId, uint8 tier) external onlyOwner {
        if (rarityLocked) revert RarityAlreadyLocked();
        _setTokenTier(tokenId, tier);
    }

    /**
     * @notice Assign rarity tiers in bulk.
     * @dev Not bounded by MAX_BATCH_SIZE: this is an owner-only configuration
     *      call whose size the owner controls, and 3333 ids must be written in
     *      a practical number of transactions. The scripts chunk it.
     */
    function setTokenTiers(uint256[] calldata tokenIds, uint8[] calldata tiers) external onlyOwner {
        if (rarityLocked) revert RarityAlreadyLocked();
        uint256 len = tokenIds.length;
        if (len == 0) revert EmptyBatch();
        if (len != tiers.length) revert LengthMismatch(len, tiers.length);

        for (uint256 i = 0; i < len; ++i) {
            _setTokenTier(tokenIds[i], tiers[i]);
        }
    }

    function _setTokenTier(uint256 tokenId, uint8 tier) private {
        if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) revert InvalidTokenId(tokenId);
        if (tier >= TIER_COUNT) revert InvalidTier(tier);

        uint8 previousPlusOne = _tierPlusOne[tokenId];
        if (previousPlusOne == 0) {
            unchecked {
                ++configuredCount;
            }
        } else {
            uint8 previousTier = previousPlusOne - 1;
            if (previousTier == tier) return; // no-op, keeps counters exact
            unchecked {
                --tierCount[previousTier];
            }
        }

        _tierPlusOne[tokenId] = tier + 1;
        unchecked {
            ++tierCount[tier];
        }
        emit TierAssigned(tokenId, tier);
    }

    /**
     * @notice Permanently freeze the rarity mapping.
     * @dev Requires all {TOTAL_SUPPLY} ids to be mapped, so the collection can
     *      never be locked in a half-configured state.
     */
    function lockRarity() external onlyOwner {
        if (rarityLocked) revert RarityAlreadyLocked();
        if (configuredCount != TOTAL_SUPPLY) revert RarityIncomplete(configuredCount, TOTAL_SUPPLY);

        rarityLocked = true;
        emit RarityLocked(configuredCount, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reward rate configuration (admin)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Update the daily rate of one tier, in reward-token base units.
     * @dev Takes effect for all future accrual. Already-accrued, unclaimed
     *      reward is measured from each token's checkpoint, so a rate change
     *      retroactively reprices the un-settled window. Settle first
     *      (see the README) if that matters for a given change.
     */
    function setRewardRate(uint8 tier, uint256 newRewardPerDay) external onlyOwner {
        if (tier >= TIER_COUNT) revert InvalidTier(tier);
        uint256 old = rewardPerDay[tier];
        rewardPerDay[tier] = newRewardPerDay;
        emit RewardRateUpdated(tier, old, newRewardPerDay);
    }

    /// @notice Update all five daily rates at once.
    function setRewardRates(uint256[TIER_COUNT] calldata ratesPerDay) external onlyOwner {
        for (uint8 t = 0; t < TIER_COUNT; ++t) {
            uint256 old = rewardPerDay[t];
            if (old == ratesPerDay[t]) continue;
            rewardPerDay[t] = ratesPerDay[t];
            emit RewardRateUpdated(t, old, ratesPerDay[t]);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reward pool
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Move `amount` of reward token from the caller into the pool.
     * @dev Uses the post-transfer balance delta, so a fee-on-transfer or
     *      rebasing token cannot make the event overstate what arrived.
     */
    function fundRewards(uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();

        uint256 before = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = rewardToken.balanceOf(address(this)) - before;

        emit RewardsFunded(msg.sender, received);
    }

    /// @notice Reward token currently held by this contract.
    function rewardTokenBalance() public view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Staking
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit one NFT into escrow and begin accruing rewards.
     * @param tokenId      Green Flock id owned by the caller.
     * @param lockDuration Seconds the NFT stays locked, from
     *                     {MIN_LOCK_DURATION} to {MAX_LOCK_DURATION}. The NFT
     *                     cannot be withdrawn before it elapses.
     */
    function stake(uint256 tokenId, uint256 lockDuration) external nonReentrant whenNotPaused {
        _validateLock(lockDuration);
        _stake(tokenId, lockDuration);
    }

    /// @notice Deposit up to {MAX_BATCH_SIZE} NFTs under one lock duration.
    function stakeBatch(uint256[] calldata tokenIds, uint256 lockDuration) external nonReentrant whenNotPaused {
        _validateLock(lockDuration);
        uint256 len = _checkBatch(tokenIds.length);
        for (uint256 i = 0; i < len; ++i) {
            _stake(tokenIds[i], lockDuration);
        }
    }

    /// @dev Rejects a lock outside the permitted window. No rounding, no clamping.
    function _validateLock(uint256 lockDuration) private pure {
        if (lockDuration < MIN_LOCK_DURATION || lockDuration > MAX_LOCK_DURATION) {
            revert InvalidLockDuration(lockDuration, MIN_LOCK_DURATION, MAX_LOCK_DURATION);
        }
    }

    /**
     * @dev Checks-effects-interactions: state is written before the external
     *      NFT transfer. `transferFrom` is used rather than `safeTransferFrom`
     *      so no receive hook fires on our own contract.
     */
    function _stake(uint256 tokenId, uint256 lockDuration) private {
        if (tokenId < MIN_TOKEN_ID || tokenId > MAX_TOKEN_ID) revert InvalidTokenId(tokenId);
        if (stakes[tokenId].owner != address(0)) revert AlreadyStaked(tokenId);

        uint8 plusOne = _tierPlusOne[tokenId];
        if (plusOne == 0) revert TierNotConfigured(tokenId);
        uint8 tier = plusOne - 1;
        if (rewardPerDay[tier] == 0) revert RewardRateNotSet(tier);

        if (nftContract.ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId, msg.sender);

        uint64 now64 = uint64(block.timestamp);
        stakes[tokenId] = StakeInfo({
            owner: msg.sender,
            tier: tier,
            stakedAt: now64,
            lastClaimAt: now64,
            lockDuration: uint64(lockDuration)
        });

        _stakedTokenIndex[tokenId] = _stakedTokens[msg.sender].length;
        _stakedTokens[msg.sender].push(tokenId);

        unchecked {
            ++totalStaked;
        }

        emit Staked(msg.sender, tokenId, tier, lockDuration, block.timestamp + lockDuration, block.timestamp);

        nftContract.transferFrom(msg.sender, address(this), tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claiming
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Claim accrued reward for one staked NFT, keeping it staked.
    function claim(uint256 tokenId) external nonReentrant {
        uint256 amount = _settle(tokenId, msg.sender);
        if (amount == 0) {
            emit RewardClaimed(msg.sender, tokenId, 0, block.timestamp);
            return;
        }

        uint256 available = rewardTokenBalance();
        if (available < amount) revert InsufficientRewardPool(amount, available);

        totalRewardsPaid += amount;
        emit RewardClaimed(msg.sender, tokenId, amount, block.timestamp);

        rewardToken.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Claim accrued reward for up to {MAX_BATCH_SIZE} staked NFTs.
     * @dev Totals first, then one aggregate transfer, so gas scales with the
     *      number of state writes rather than the number of ERC-20 calls.
     */
    function claimBatch(uint256[] calldata tokenIds) external nonReentrant {
        uint256 len = _checkBatch(tokenIds.length);

        uint256 total;
        for (uint256 i = 0; i < len; ++i) {
            uint256 amount = _settle(tokenIds[i], msg.sender);
            total += amount;
            emit RewardClaimed(msg.sender, tokenIds[i], amount, block.timestamp);
        }

        emit RewardBatchClaimed(msg.sender, len, total);
        if (total == 0) return;

        uint256 available = rewardTokenBalance();
        if (available < total) revert InsufficientRewardPool(total, available);

        totalRewardsPaid += total;
        rewardToken.safeTransfer(msg.sender, total);
    }

    /**
     * @dev Validates the stake, enforces the 24h per-NFT cooldown, computes
     *      pending reward and advances the accrual checkpoint. Reverting here
     *      (rather than skipping) means a batch containing someone else's
     *      token, or a token still inside its cooldown, fails as a whole.
     */
    function _settle(uint256 tokenId, address caller) private returns (uint256 amount) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) revert NotStaked(tokenId);
        if (s.owner != caller) revert NotStaker(tokenId, caller);

        uint256 nextClaimAt = uint256(s.lastClaimAt) + CLAIM_COOLDOWN;
        if (block.timestamp < nextClaimAt) revert ClaimCooldownActive(tokenId, nextClaimAt);

        amount = _pending(s);
        s.lastClaimAt = uint64(block.timestamp);
    }

    /**
     * @notice Withdraw the reward credited during an unstake that happened
     *         while the pool was short.
     */
    function claimOwed() external nonReentrant {
        uint256 amount = owedRewards[msg.sender];
        if (amount == 0) revert NothingOwed();

        uint256 available = rewardTokenBalance();
        if (available < amount) revert InsufficientRewardPool(amount, available);

        owedRewards[msg.sender] = 0;
        totalRewardsPaid += amount;
        emit OwedRewardPaid(msg.sender, amount);

        rewardToken.safeTransfer(msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Unstaking
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Settle rewards and withdraw one NFT back to its staker.
    function unstake(uint256 tokenId) external nonReentrant {
        uint256 amount = _unstake(tokenId);
        if (amount == 0) return;

        uint256 available = rewardTokenBalance();
        if (available < amount) {
            // The NFT has already been returned. Record the debt instead of
            // reverting, so an unfunded pool can never hold an NFT hostage.
            owedRewards[msg.sender] += amount;
            emit RewardDeferred(msg.sender, tokenId, amount);
            return;
        }

        totalRewardsPaid += amount;
        rewardToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Settle and withdraw up to {MAX_BATCH_SIZE} NFTs in one transaction.
    function unstakeBatch(uint256[] calldata tokenIds) external nonReentrant {
        uint256 len = _checkBatch(tokenIds.length);

        uint256 total;
        for (uint256 i = 0; i < len; ++i) {
            total += _unstake(tokenIds[i]);
        }
        if (total == 0) return;

        uint256 available = rewardTokenBalance();
        if (available < total) {
            owedRewards[msg.sender] += total;
            emit RewardDeferred(msg.sender, 0, total);
            return;
        }

        totalRewardsPaid += total;
        rewardToken.safeTransfer(msg.sender, total);
    }

    /**
     * @dev Clears the record, then returns the NFT. Reward payment is left to
     *      the caller so a batch can settle with a single ERC-20 transfer.
     *
     *      The lock is absolute: before `unlockAt` this reverts, including
     *      while paused and including for the contract owner. Unstaking is the
     *      one settlement path with no cooldown — the whole accrued balance is
     *      paid out (or credited) as the position closes, so ending a stake is
     *      never delayed by a claim made in the last 24 hours.
     */
    function _unstake(uint256 tokenId) private returns (uint256 amount) {
        StakeInfo storage s = stakes[tokenId];
        address staker = s.owner;
        if (staker == address(0)) revert NotStaked(tokenId);
        if (staker != msg.sender) revert NotStaker(tokenId, msg.sender);

        uint256 unlockAt = uint256(s.stakedAt) + uint256(s.lockDuration);
        if (block.timestamp < unlockAt) revert StakeLocked(tokenId, unlockAt);

        amount = _pending(s);

        _removeFromStakedList(staker, tokenId);
        delete stakes[tokenId];
        unchecked {
            --totalStaked;
        }

        emit Unstaked(staker, tokenId, amount, block.timestamp);

        nftContract.transferFrom(address(this), staker, tokenId);
    }

    function _removeFromStakedList(address staker, uint256 tokenId) private {
        uint256[] storage list = _stakedTokens[staker];
        uint256 index = _stakedTokenIndex[tokenId];
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            uint256 movedTokenId = list[lastIndex];
            list[index] = movedTokenId;
            _stakedTokenIndex[movedTokenId] = index;
        }

        list.pop();
        delete _stakedTokenIndex[tokenId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reward accrued since the last settlement for a staked token.
    function pendingReward(uint256 tokenId) external view returns (uint256) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) return 0;
        return _pending(s);
    }

    /// @notice Total pending reward across every token staked by `user`.
    function pendingRewardOf(address user) external view returns (uint256 total) {
        uint256[] storage list = _stakedTokens[user];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; ++i) {
            total += _pending(stakes[list[i]]);
        }
    }

    /// @dev Accrual runs from the last settlement, so the cooldown defers
    ///      payment without ever reducing what is owed.
    function _pending(StakeInfo storage s) private view returns (uint256) {
        uint256 elapsed = block.timestamp - uint256(s.lastClaimAt);
        if (elapsed == 0) return 0;
        return (rewardPerDay[s.tier] * elapsed) / REWARD_PERIOD;
    }

    /**
     * @notice Full stake record plus live pending reward.
     * @return owner       Staker, or the zero address when not staked.
     * @return tier        Rarity tier of the token.
     * @return stakedAt    Deposit timestamp; the lock anchor.
     * @return lastClaimAt Last settlement; the accrual and cooldown anchor.
     * @return lockDuration Committed lock in seconds.
     * @return unlockAt    `stakedAt + lockDuration`.
     * @return nextClaimAt `lastClaimAt + CLAIM_COOLDOWN`.
     * @return pending     Reward accrued since `lastClaimAt`.
     */
    function getStakeInfo(uint256 tokenId)
        external
        view
        returns (
            address owner,
            uint8 tier,
            uint256 stakedAt,
            uint256 lastClaimAt,
            uint256 lockDuration,
            uint256 unlockAt,
            uint256 nextClaimAt,
            uint256 pending
        )
    {
        StakeInfo storage s = stakes[tokenId];
        owner = s.owner;
        if (owner == address(0)) return (address(0), 0, 0, 0, 0, 0, 0, 0);

        tier = s.tier;
        stakedAt = uint256(s.stakedAt);
        lastClaimAt = uint256(s.lastClaimAt);
        lockDuration = uint256(s.lockDuration);
        unlockAt = stakedAt + lockDuration;
        nextClaimAt = lastClaimAt + CLAIM_COOLDOWN;
        pending = _pending(s);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lock and cooldown views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permitted lock window, in seconds, and the claim cooldown.
    function lockBounds()
        external
        pure
        returns (uint256 minDuration, uint256 maxDuration, uint256 claimCooldown)
    {
        return (MIN_LOCK_DURATION, MAX_LOCK_DURATION, CLAIM_COOLDOWN);
    }

    /// @notice Timestamp `tokenId` becomes withdrawable. Zero when not staked.
    function unlockTimeOf(uint256 tokenId) external view returns (uint256) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) return 0;
        return uint256(s.stakedAt) + uint256(s.lockDuration);
    }

    /// @notice Whether `tokenId` is staked and past its unlock time.
    function isUnlocked(uint256 tokenId) external view returns (bool) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) return false;
        return block.timestamp >= uint256(s.stakedAt) + uint256(s.lockDuration);
    }

    /// @notice Earliest timestamp `tokenId` may be claimed. Zero when not staked.
    function nextClaimTimeOf(uint256 tokenId) external view returns (uint256) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) return 0;
        return uint256(s.lastClaimAt) + CLAIM_COOLDOWN;
    }

    /// @notice Whether `tokenId` is staked and outside its claim cooldown.
    function canClaim(uint256 tokenId) external view returns (bool) {
        StakeInfo storage s = stakes[tokenId];
        if (s.owner == address(0)) return false;
        return block.timestamp >= uint256(s.lastClaimAt) + CLAIM_COOLDOWN;
    }

    /**
     * @notice Reward that `user` could withdraw right now: the pending total
     *         restricted to tokens whose 24h cooldown has elapsed.
     * @dev Differs from {pendingRewardOf}, which counts every token including
     *      those still cooling down. The dashboard shows both: "earned" and
     *      "claimable now".
     */
    function claimableRewardOf(address user) external view returns (uint256 total) {
        uint256[] storage list = _stakedTokens[user];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; ++i) {
            StakeInfo storage s = stakes[list[i]];
            if (block.timestamp >= uint256(s.lastClaimAt) + CLAIM_COOLDOWN) {
                total += _pending(s);
            }
        }
    }

    /// @notice Combined reward per second across every token `user` has staked.
    function rewardRateOf(address user) external view returns (uint256 ratePerSecond) {
        uint256[] storage list = _stakedTokens[user];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; ++i) {
            ratePerSecond += rewardPerDay[stakes[list[i]].tier] / REWARD_PERIOD;
        }
    }

    /// @notice Ids `user` has staked that are already past their unlock time.
    function unlockedTokenIdsOf(address user) external view returns (uint256[] memory unlockedIds) {
        uint256[] storage list = _stakedTokens[user];
        uint256 len = list.length;
        uint256[] memory buffer = new uint256[](len);
        uint256 count;
        for (uint256 i = 0; i < len; ++i) {
            StakeInfo storage s = stakes[list[i]];
            if (block.timestamp >= uint256(s.stakedAt) + uint256(s.lockDuration)) {
                buffer[count++] = list[i];
            }
        }
        unlockedIds = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            unlockedIds[i] = buffer[i];
        }
    }

    /// @notice Ids `user` has staked whose claim cooldown has elapsed.
    function claimableTokenIdsOf(address user) external view returns (uint256[] memory claimableIds) {
        uint256[] storage list = _stakedTokens[user];
        uint256 len = list.length;
        uint256[] memory buffer = new uint256[](len);
        uint256 count;
        for (uint256 i = 0; i < len; ++i) {
            StakeInfo storage s = stakes[list[i]];
            if (block.timestamp >= uint256(s.lastClaimAt) + CLAIM_COOLDOWN) {
                buffer[count++] = list[i];
            }
        }
        claimableIds = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            claimableIds[i] = buffer[i];
        }
    }

    /// @notice Whether `tokenId` is currently held in escrow.
    function isStaked(uint256 tokenId) external view returns (bool) {
        return stakes[tokenId].owner != address(0);
    }

    /// @notice The address that staked `tokenId`, or the zero address.
    function stakerOf(uint256 tokenId) external view returns (address) {
        return stakes[tokenId].owner;
    }

    /// @notice Every token id currently staked by `user`.
    function getStakedTokenIds(address user) external view returns (uint256[] memory) {
        return _stakedTokens[user];
    }

    /// @notice Number of tokens `user` currently has staked.
    function stakedBalanceOf(address user) external view returns (uint256) {
        return _stakedTokens[user].length;
    }

    /// @notice Configured tier of `tokenId`. Reverts when unconfigured.
    function tokenTier(uint256 tokenId) public view returns (uint8) {
        uint8 plusOne = _tierPlusOne[tokenId];
        if (plusOne == 0) revert TierNotConfigured(tokenId);
        return plusOne - 1;
    }

    /// @notice Non-reverting tier lookup.
    function isTierConfigured(uint256 tokenId) external view returns (bool) {
        return _tierPlusOne[tokenId] != 0;
    }

    /// @notice All five daily rates, in reward-token base units.
    function getRewardRates() external view returns (uint256[TIER_COUNT] memory) {
        return rewardPerDay;
    }

    /// @notice Per-tier counts of configured token ids.
    function getTierCounts() external view returns (uint256[TIER_COUNT] memory) {
        return tierCount;
    }

    /// @notice Ids in `tokenIds` that still have no tier assigned.
    function unconfiguredTokenIds(uint256[] calldata tokenIds) external view returns (uint256[] memory missing) {
        uint256 len = tokenIds.length;
        uint256 count;
        uint256[] memory buffer = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            if (_tierPlusOne[tokenIds[i]] == 0) {
                buffer[count++] = tokenIds[i];
            }
        }
        missing = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            missing[i] = buffer[i];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pause (deposits only)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Stop new deposits. Claiming and unstaking remain available.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume deposits.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Guards
    // ─────────────────────────────────────────────────────────────────────────

    function _checkBatch(uint256 len) private pure returns (uint256) {
        if (len == 0) revert EmptyBatch();
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge(len, MAX_BATCH_SIZE);
        return len;
    }

    /**
     * @notice Rejects NFTs pushed in with `safeTransferFrom`.
     * @dev {stake} uses `transferFrom`, so this hook never fires on the staking
     *      path. Reverting here prevents a direct transfer from creating an
     *      escrowed NFT with no stake record, which would be unrecoverable.
     */
    function onERC721Received(address, address, uint256, bytes memory) public pure override returns (bytes4) {
        revert DirectNftTransferNotAllowed();
    }
}
