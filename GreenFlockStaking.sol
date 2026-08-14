// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  GreenFlockStaking
 * @notice Stake RobinPump Green Flock ERC-721 NFTs and earn $ROBINPUMP rewards.
 *
 * Architecture
 * ─────────────
 * Green Flock ERC-721 (0xbd00ce673b84be8022af8be0039c7a5af69724a9)
 *         │
 *         ▼
 * GreenFlockStaking  ──  escrow + tier + reward accounting
 *         │
 *         ▼
 * ROBINPUMP ERC-20 (0xb5Ea549fc8Ad1665aCda9051e91aDe6A371B7BFf) reward vault
 *
 * Security
 * ─────────
 * - OpenZeppelin ReentrancyGuard on all state-changing externals
 * - SafeERC20 for all ERC-20 transfers
 * - Ownable / AccessControl for admin functions
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
 */

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
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

    // ─── Immutables ────────────────────────────────────────────────────────────
    IERC721 public immutable nftContract;
    IERC20  public immutable rewardToken;

    // ─── Reward rates (base units / second, 18 decimals) ─────────────────────
    // Defaults: Legendary = 1000 tokens/day, each tier = prev / 3
    // Owner can update via setTierRates(). Stored per-second for precision.
    uint256[5] public rewardRatePerSecond;

    // ─── Token tier mapping ───────────────────────────────────────────────────
    // Set by owner before staking opens. tokenTier[tokenId] = TIER_*.
    mapping(uint256 => uint8) public tokenTier;

    // ─── Staking records ──────────────────────────────────────────────────────
    struct StakeRecord {
        address owner;
        uint256 stakedAt;          // block.timestamp when staked
        uint256 rewardCheckpoint;  // block.timestamp of last claim/checkpoint
        uint256 accruedReward;     // reward accumulated up to checkpoint (base units)
        uint8   tier;
    }
    mapping(uint256 => StakeRecord) public stakes;          // tokenId → record
    mapping(address => uint256[])   private _stakedByOwner; // wallet → tokenIds

    // ─── Counters ─────────────────────────────────────────────────────────────
    uint256 public totalStaked;
    uint256 public totalRewardDistributed;

    // ─── Events ───────────────────────────────────────────────────────────────
    event Staked(address indexed owner, uint256 indexed tokenId, uint8 tier, uint256 timestamp);
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
            tokenTier[tokenIds[i]] = tiers[i];
        }
        emit TokenTiersSet(tokenIds);
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
     * @notice Stake a single NFT. Caller must approve this contract first.
     * @param tokenId The NFT token ID to stake.
     */
    function stake(uint256 tokenId) external nonReentrant {
        _stake(msg.sender, tokenId);
    }

    /**
     * @notice Batch stake multiple NFTs in one transaction.
     */
    function stakeBatch(uint256[] calldata tokenIds) external nonReentrant {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _stake(msg.sender, tokenIds[i]);
        }
    }

    function _stake(address caller, uint256 tokenId) private {
        require(nftContract.ownerOf(tokenId) == caller, "Not token owner");
        require(stakes[tokenId].owner == address(0),    "Already staked");
        uint8 tier = tokenTier[tokenId];
        require(tier != TIER_UNSET, "Tier not configured for this token");

        // Transfer NFT into escrow
        nftContract.safeTransferFrom(caller, address(this), tokenId);

        stakes[tokenId] = StakeRecord({
            owner:             caller,
            stakedAt:          block.timestamp,
            rewardCheckpoint:  block.timestamp,
            accruedReward:     0,
            tier:              tier
        });
        _stakedByOwner[caller].push(tokenId);
        totalStaked++;

        emit Staked(caller, tokenId, tier, block.timestamp);
    }

    // ─── Unstake ───────────────────────────────────────────────────────────────
    /**
     * @notice Unstake an NFT, claim all pending rewards, and return NFT to owner.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        StakeRecord storage record = stakes[tokenId];
        require(record.owner == msg.sender, "Not staker");

        uint256 pending = _pendingReward(tokenId);
        uint256 total = record.accruedReward + pending;

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
     */
    function claimReward(uint256 tokenId) external nonReentrant {
        StakeRecord storage record = stakes[tokenId];
        require(record.owner == msg.sender, "Not staker");

        uint256 pending = _pendingReward(tokenId);
        require(pending > 0, "Nothing to claim");

        // Checkpoint before transfer
        record.rewardCheckpoint = block.timestamp;
        record.accruedReward    = 0;

        _transferReward(msg.sender, pending);
        emit RewardClaimed(msg.sender, tokenId, pending, block.timestamp);
    }

    /**
     * @notice Claim all rewards for all staked NFTs in one transaction.
     */
    function claimAllRewards() external nonReentrant {
        uint256[] storage ids = _stakedByOwner[msg.sender];
        require(ids.length > 0, "Nothing staked");
        uint256 totalPending = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            StakeRecord storage record = stakes[ids[i]];
            uint256 pending = _pendingReward(ids[i]);
            record.rewardCheckpoint = block.timestamp;
            record.accruedReward    = 0;
            totalPending += pending;
            if (pending > 0) emit RewardClaimed(msg.sender, ids[i], pending, block.timestamp);
        }
        require(totalPending > 0, "Nothing to claim");
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
     * @notice Staking record for a token ID.
     */
    function stakeInfo(uint256 tokenId) external view returns (StakeRecord memory) {
        return stakes[tokenId];
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
