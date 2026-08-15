/**
 * RobinPumpNFTStaking — full behavioural test matrix.
 *
 * Everything here runs against the in-process Hardhat network using
 * MockERC721 (stand-in for Green Flock) and MockERC20 deployed with
 * 6 decimals ON PURPOSE: an 18-decimal assumption anywhere in the stack
 * would make these tests fail.
 */

// Registered explicitly here, not only via hardhat.config.ts. On Windows the
// config is loaded under a lower-cased drive letter ("d:\...") while this file
// resolves "D:\...", which puts two separate chai instances in require.cache.
// The plugin would then decorate the config's instance and leave this one bare,
// so `revertedWithCustomError`, `emit` and the bigint-aware equality would all
// be missing. Importing it here guarantees the matchers land on the same chai
// object `expect` below comes from.
import '@nomicfoundation/hardhat-chai-matchers';

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import type { Contract } from 'ethers';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const DECIMALS = 6;
const DAY = 86_400n;
const TOTAL_SUPPLY = 3333;
const MAX_BATCH = 50;

/** Lock window and cooldown, mirroring the contract constants. */
const MIN_LOCK = 7n * DAY;
const MAX_LOCK = 1095n * DAY;
const COOLDOWN = 24n * 3_600n;

/** Default lock used by every helper that does not care about the duration. */
const LOCK = MIN_LOCK;

/** Whole-token rates from config/tiers.json, converted at 6 decimals. */
const RATE_STRINGS = ['1000', '333.333333', '111.111111', '37.037037', '12.345679'] as const;
const RATES: bigint[] = RATE_STRINGS.map(r => ethers.parseUnits(r, DECIMALS));

const POOL = ethers.parseUnits('1000000', DECIMALS);

/** Contract-side integer math, reproduced exactly (floor division). */
function expectedReward(tier: number, seconds: bigint): bigint {
  return (RATES[tier] * seconds) / DAY;
}

/** tokenId -> tier, matching the fixture's assignment. */
function tierOf(tokenId: number): number {
  return (tokenId - 1) % 5;
}

interface Ctx {
  staking: Contract;
  nft: Contract;
  token: Contract;
  stakingAddress: string;
  nftAddress: string;
  tokenAddress: string;
  owner: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
}

async function baseDeploy(rates: bigint[] = RATES): Promise<Ctx> {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  const nft = (await (await ethers.getContractFactory('MockERC721')).deploy(
    'Green Flock',
    'FLOCK'
  )) as unknown as Contract;
  const token = (await (await ethers.getContractFactory('MockERC20')).deploy(
    'RobinPump',
    'ROBINPUMP',
    DECIMALS
  )) as unknown as Contract;

  const nftAddress = await nft.getAddress();
  const tokenAddress = await token.getAddress();

  const staking = (await (await ethers.getContractFactory('RobinPumpNFTStaking')).deploy(
    nftAddress,
    tokenAddress,
    owner.address,
    rates
  )) as unknown as Contract;
  const stakingAddress = await staking.getAddress();

  // alice: 1..60, bob: 61..70, alice also holds 3300 which stays unconfigured.
  await nft.mintBatch(alice.address, 1, 60);
  await nft.mintBatch(bob.address, 61, 10);
  await nft.mint(alice.address, 3300);

  await nft.connect(alice).setApprovalForAll(stakingAddress, true);
  await nft.connect(bob).setApprovalForAll(stakingAddress, true);

  // Configure tiers for ids 1..70 only. 3300 is deliberately left unset.
  const ids: number[] = [];
  const tiers: number[] = [];
  for (let id = 1; id <= 70; id++) {
    ids.push(id);
    tiers.push(tierOf(id));
  }
  await staking.setTokenTiers(ids, tiers);

  return { staking, nft, token, stakingAddress, nftAddress, tokenAddress, owner, alice, bob, carol };
}

/** Deployed, tiers configured for 1..70, reward pool funded. */
async function fundedFixture(): Promise<Ctx> {
  const ctx = await baseDeploy();
  await ctx.token.mint(ctx.owner.address, POOL * 2n);
  await ctx.token.connect(ctx.owner).approve(ctx.stakingAddress, POOL);
  await ctx.staking.fundRewards(POOL);
  return ctx;
}

/** Same wiring, but the reward pool is empty. */
async function unfundedFixture(): Promise<Ctx> {
  return baseDeploy();
}

/** Tier 4 rate is zero, so that tier cannot be staked. */
async function zeroRateFixture(): Promise<Ctx> {
  return baseDeploy([RATES[0], RATES[1], RATES[2], RATES[3], 0n]);
}

/** Rates so small that a short window truncates to zero reward. */
async function tinyRateFixture(): Promise<Ctx> {
  return baseDeploy([100n, 100n, 100n, 100n, 100n]);
}

/** Every one of the 3333 ids mapped, so lockRarity() is reachable. */
async function fullyConfiguredFixture(): Promise<Ctx> {
  const ctx = await baseDeploy();
  const CHUNK = 500;
  for (let start = 1; start <= TOTAL_SUPPLY; start += CHUNK) {
    const ids: number[] = [];
    const tiers: number[] = [];
    for (let id = start; id < start + CHUNK && id <= TOTAL_SUPPLY; id++) {
      ids.push(id);
      tiers.push(tierOf(id));
    }
    await ctx.staking.setTokenTiers(ids, tiers);
  }
  return ctx;
}

/**
 * Stake and return the exact block timestamp, which is both the lock anchor
 * (`stakedAt`) and the initial accrual/cooldown anchor (`lastClaimAt`).
 */
async function stakeAt(
  ctx: Ctx,
  signer: HardhatEthersSigner,
  tokenId: number,
  lockDuration: bigint = LOCK
): Promise<bigint> {
  const tx = await ctx.staking.connect(signer).stake(tokenId, lockDuration);
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  return BigInt(block!.timestamp);
}

describe('RobinPumpNFTStaking', () => {
  // ───────────────────────────────────────────────────────────────────────────
  describe('deployment', () => {
    it('stores the NFT and reward token as immutables', async () => {
      const { staking, nftAddress, tokenAddress } = await loadFixture(fundedFixture);
      expect(await staking.nftContract()).to.equal(nftAddress);
      expect(await staking.rewardToken()).to.equal(tokenAddress);
    });

    it('assigns the requested initial owner', async () => {
      const { staking, owner } = await loadFixture(fundedFixture);
      expect(await staking.owner()).to.equal(owner.address);
    });

    it('applies all five constructor rates in base units', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const onChain: bigint[] = [...(await staking.getRewardRates())];
      expect(onChain).to.deep.equal(RATES);
    });

    it('exposes the collection and batch constants', async () => {
      const { staking } = await loadFixture(fundedFixture);
      expect(await staking.TIER_COUNT()).to.equal(5);
      expect(await staking.MIN_TOKEN_ID()).to.equal(1);
      expect(await staking.MAX_TOKEN_ID()).to.equal(TOTAL_SUPPLY);
      expect(await staking.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
      expect(await staking.MAX_BATCH_SIZE()).to.equal(MAX_BATCH);
      expect(await staking.REWARD_PERIOD()).to.equal(DAY);
    });

    it('exposes the lock window and claim cooldown as constants', async () => {
      const { staking } = await loadFixture(fundedFixture);
      expect(await staking.MIN_LOCK_DURATION()).to.equal(MIN_LOCK);
      expect(await staking.MAX_LOCK_DURATION()).to.equal(MAX_LOCK);
      expect(await staking.CLAIM_COOLDOWN()).to.equal(COOLDOWN);

      // The user-facing rules, stated in the units the user gave them in.
      expect(MIN_LOCK).to.equal(604_800n); // 7 days
      expect(MAX_LOCK).to.equal(94_608_000n); // 3 years
      expect(COOLDOWN).to.equal(86_400n); // 24 hours
    });

    it('rejects a zero NFT or reward address', async () => {
      const [owner] = await ethers.getSigners();
      const factory = await ethers.getContractFactory('RobinPumpNFTStaking');
      const someAddress = owner.address;

      await expect(
        factory.deploy(ethers.ZeroAddress, someAddress, owner.address, RATES)
      ).to.be.revertedWithCustomError(factory, 'ZeroAddress');

      await expect(
        factory.deploy(someAddress, ethers.ZeroAddress, owner.address, RATES)
      ).to.be.revertedWithCustomError(factory, 'ZeroAddress');
    });

    it('reads a non-18 decimals() from the reward token', async () => {
      const { token } = await loadFixture(fundedFixture);
      expect(await token.decimals()).to.equal(DECIMALS);
      expect(RATES[0]).to.equal(1_000_000_000n); // 1000 tokens at 6 decimals
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('rarity configuration', () => {
    it('assigns a single tier and counts it once', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const before: bigint = await staking.configuredCount();

      await expect(staking.setTokenTier(200, 2)).to.emit(staking, 'TierAssigned').withArgs(200, 2);

      expect(await staking.tokenTier(200)).to.equal(2);
      expect(await staking.isTierConfigured(200)).to.equal(true);
      expect(await staking.configuredCount()).to.equal(before + 1n);
    });

    it('keeps tier counters exact when a tier is reassigned', async () => {
      const { staking } = await loadFixture(fundedFixture);
      await staking.setTokenTier(200, 2);

      const before: bigint[] = [...(await staking.getTierCounts())];
      const configuredBefore: bigint = await staking.configuredCount();

      await staking.setTokenTier(200, 4);

      const after: bigint[] = [...(await staking.getTierCounts())];
      expect(after[2]).to.equal(before[2] - 1n);
      expect(after[4]).to.equal(before[4] + 1n);
      expect(await staking.configuredCount()).to.equal(configuredBefore);
      expect(await staking.tokenTier(200)).to.equal(4);
    });

    it('treats an identical reassignment as a no-op', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const counts: bigint[] = [...(await staking.getTierCounts())];
      const configured: bigint = await staking.configuredCount();

      await staking.setTokenTier(1, tierOf(1));

      expect([...(await staking.getTierCounts())]).to.deep.equal(counts);
      expect(await staking.configuredCount()).to.equal(configured);
    });

    it('rejects token ids outside 1..3333', async () => {
      const { staking } = await loadFixture(fundedFixture);
      await expect(staking.setTokenTier(0, 0))
        .to.be.revertedWithCustomError(staking, 'InvalidTokenId')
        .withArgs(0);
      await expect(staking.setTokenTier(TOTAL_SUPPLY + 1, 0))
        .to.be.revertedWithCustomError(staking, 'InvalidTokenId')
        .withArgs(TOTAL_SUPPLY + 1);
    });

    it('rejects a tier index above 4', async () => {
      const { staking } = await loadFixture(fundedFixture);
      await expect(staking.setTokenTier(200, 5))
        .to.be.revertedWithCustomError(staking, 'InvalidTier')
        .withArgs(5);
    });

    it('rejects an empty or mismatched batch', async () => {
      const { staking } = await loadFixture(fundedFixture);
      await expect(staking.setTokenTiers([], [])).to.be.revertedWithCustomError(
        staking,
        'EmptyBatch'
      );
      await expect(staking.setTokenTiers([200, 201], [1]))
        .to.be.revertedWithCustomError(staking, 'LengthMismatch')
        .withArgs(2, 1);
    });

    it('only lets the owner write rarity', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).setTokenTier(200, 1))
        .to.be.revertedWithCustomError(staking, 'OwnableUnauthorizedAccount')
        .withArgs(alice.address);
      await expect(
        staking.connect(alice).setTokenTiers([200], [1])
      ).to.be.revertedWithCustomError(staking, 'OwnableUnauthorizedAccount');
    });

    it('reverts tokenTier() for an unconfigured id and reports it as unconfigured', async () => {
      const { staking } = await loadFixture(fundedFixture);
      expect(await staking.isTierConfigured(3300)).to.equal(false);
      await expect(staking.tokenTier(3300))
        .to.be.revertedWithCustomError(staking, 'TierNotConfigured')
        .withArgs(3300);
    });

    it('lists exactly the ids that are still unmapped', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const missing: bigint[] = await staking.unconfiguredTokenIds([1, 3300, 70, 3301]);
      expect(missing.map(Number)).to.deep.equal([3300, 3301]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('lockRarity', () => {
    it('refuses to lock while any id is unmapped', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const configured: bigint = await staking.configuredCount();
      await expect(staking.lockRarity())
        .to.be.revertedWithCustomError(staking, 'RarityIncomplete')
        .withArgs(configured, TOTAL_SUPPLY);
    });

    it('locks once all 3333 ids are mapped, then freezes every rarity write', async () => {
      const { staking } = await loadFixture(fullyConfiguredFixture);
      expect(await staking.configuredCount()).to.equal(TOTAL_SUPPLY);

      await expect(staking.lockRarity()).to.emit(staking, 'RarityLocked');
      expect(await staking.rarityLocked()).to.equal(true);

      await expect(staking.setTokenTier(1, 3)).to.be.revertedWithCustomError(
        staking,
        'RarityAlreadyLocked'
      );
      await expect(staking.setTokenTiers([1], [3])).to.be.revertedWithCustomError(
        staking,
        'RarityAlreadyLocked'
      );
      await expect(staking.lockRarity()).to.be.revertedWithCustomError(
        staking,
        'RarityAlreadyLocked'
      );
    });

    it('is owner-only', async () => {
      const { staking, alice } = await loadFixture(fullyConfiguredFixture);
      await expect(staking.connect(alice).lockRarity()).to.be.revertedWithCustomError(
        staking,
        'OwnableUnauthorizedAccount'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('reward rates', () => {
    it('updates one tier and reports the previous value', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const next = ethers.parseUnits('500', DECIMALS);
      await expect(staking.setRewardRate(0, next))
        .to.emit(staking, 'RewardRateUpdated')
        .withArgs(0, RATES[0], next);
      expect((await staking.getRewardRates())[0]).to.equal(next);
    });

    it('updates all five tiers at once', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const next = RATES.map(r => r / 2n);
      await staking.setRewardRates(next);
      expect([...(await staking.getRewardRates())]).to.deep.equal(next);
    });

    it('rejects an invalid tier and non-owner callers', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.setRewardRate(5, 1n))
        .to.be.revertedWithCustomError(staking, 'InvalidTier')
        .withArgs(5);
      await expect(
        staking.connect(alice).setRewardRate(0, 1n)
      ).to.be.revertedWithCustomError(staking, 'OwnableUnauthorizedAccount');
      await expect(
        staking.connect(alice).setRewardRates(RATES)
      ).to.be.revertedWithCustomError(staking, 'OwnableUnauthorizedAccount');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('reward pool', () => {
    it('pulls funding from the owner and reports what actually arrived', async () => {
      const { staking, token, stakingAddress, owner } = await loadFixture(unfundedFixture);
      const amount = ethers.parseUnits('1234.5', DECIMALS);
      await token.mint(owner.address, amount);
      await token.approve(stakingAddress, amount);

      await expect(staking.fundRewards(amount))
        .to.emit(staking, 'RewardsFunded')
        .withArgs(owner.address, amount);

      expect(await staking.rewardTokenBalance()).to.equal(amount);
    });

    it('rejects a zero amount and non-owner funding', async () => {
      const { staking, token, stakingAddress, alice } = await loadFixture(unfundedFixture);
      await expect(staking.fundRewards(0)).to.be.revertedWithCustomError(staking, 'ZeroAmount');

      await token.mint(alice.address, 10n);
      await token.connect(alice).approve(stakingAddress, 10n);
      await expect(staking.connect(alice).fundRewards(10n)).to.be.revertedWithCustomError(
        staking,
        'OwnableUnauthorizedAccount'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('staking', () => {
    it('escrows the NFT and records the stake', async () => {
      const { staking, nft, stakingAddress, alice } = await loadFixture(fundedFixture);

      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);

      expect(await nft.ownerOf(1)).to.equal(stakingAddress);
      expect(await staking.totalStaked()).to.equal(1);
      expect(await staking.isStaked(1)).to.equal(true);
      expect(await staking.stakerOf(1)).to.equal(alice.address);

      const info = await staking.getStakeInfo(1);
      expect(info[0]).to.equal(alice.address);
      expect(info[1]).to.equal(tierOf(1));
      expect(info[2]).to.equal(stakedAt); // stakedAt
      expect(info[3]).to.equal(stakedAt); // lastClaimAt starts at the deposit
      expect(info[4]).to.equal(LOCK); // lockDuration
      expect(info[5]).to.equal(stakedAt + LOCK); // unlockAt
      expect(info[6]).to.equal(stakedAt + COOLDOWN); // nextClaimAt

      expect((await staking.getStakedTokenIds(alice.address)).map(Number)).to.deep.equal([1]);
      expect(await staking.stakedBalanceOf(alice.address)).to.equal(1);
    });

    it('emits Staked with the committed lock and its unlock time', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const lock = 30n * DAY;
      const next = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(next);

      await expect(staking.connect(alice).stake(1, lock))
        .to.emit(staking, 'Staked')
        .withArgs(alice.address, 1, tierOf(1), lock, BigInt(next) + lock, next);
    });

    it('refuses an id with no configured tier', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).stake(3300, LOCK))
        .to.be.revertedWithCustomError(staking, 'TierNotConfigured')
        .withArgs(3300);
    });

    it('refuses a tier whose rate is zero', async () => {
      const { staking, alice } = await loadFixture(zeroRateFixture);
      // id 5 maps to tier 4, whose rate is 0 in this fixture.
      await expect(staking.connect(alice).stake(5, LOCK))
        .to.be.revertedWithCustomError(staking, 'RewardRateNotSet')
        .withArgs(4);
      // A funded tier still works.
      await expect(staking.connect(alice).stake(1, LOCK)).to.emit(staking, 'Staked');
    });

    it('refuses an id the caller does not own', async () => {
      const { staking, carol } = await loadFixture(fundedFixture);
      await expect(staking.connect(carol).stake(1, LOCK))
        .to.be.revertedWithCustomError(staking, 'NotTokenOwner')
        .withArgs(1, carol.address);
    });

    it('refuses an id that is already staked', async () => {
      const { staking, alice, bob } = await loadFixture(fundedFixture);
      await staking.connect(alice).stake(1, LOCK);
      await expect(staking.connect(bob).stake(1, LOCK))
        .to.be.revertedWithCustomError(staking, 'AlreadyStaked')
        .withArgs(1);
    });

    it('refuses an out-of-range id', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).stake(0, LOCK))
        .to.be.revertedWithCustomError(staking, 'InvalidTokenId')
        .withArgs(0);
      await expect(staking.connect(alice).stake(TOTAL_SUPPLY + 1, LOCK))
        .to.be.revertedWithCustomError(staking, 'InvalidTokenId')
        .withArgs(TOTAL_SUPPLY + 1);
    });

    it('stakes a batch and enforces the batch bounds', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);

      const fifty = Array.from({ length: MAX_BATCH }, (_, i) => i + 1);
      await staking.connect(alice).stakeBatch(fifty, LOCK);
      expect(await staking.totalStaked()).to.equal(MAX_BATCH);
      expect(await staking.stakedBalanceOf(alice.address)).to.equal(MAX_BATCH);

      await expect(staking.connect(alice).stakeBatch([], LOCK)).to.be.revertedWithCustomError(
        staking,
        'EmptyBatch'
      );

      const fiftyOne = Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1);
      await expect(staking.connect(alice).stakeBatch(fiftyOne, LOCK))
        .to.be.revertedWithCustomError(staking, 'BatchTooLarge')
        .withArgs(MAX_BATCH + 1, MAX_BATCH);
    });

    it('rejects an NFT pushed in with safeTransferFrom', async () => {
      const { staking, nft, stakingAddress, alice } = await loadFixture(fundedFixture);
      await expect(
        nft
          .connect(alice)
          ['safeTransferFrom(address,address,uint256)'](alice.address, stakingAddress, 1)
      ).to.be.revertedWithCustomError(staking, 'DirectNftTransferNotAllowed');
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('reward accrual', () => {
    it('accrues each tier at its own daily rate', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);

      for (const tokenId of [1, 2, 3, 4, 5]) {
        const stakedAt = await stakeAt({ staking } as Ctx, alice, tokenId);
        await time.increaseTo(Number(stakedAt + DAY));
        expect(await staking.pendingReward(tokenId)).to.equal(expectedReward(tierOf(tokenId), DAY));
      }
    });

    it('accrues pro rata within a day, floored to whole base units', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 2); // tier 1
      const elapsed = 3_600n;
      await time.increaseTo(Number(stakedAt + elapsed));
      expect(await staking.pendingReward(2)).to.equal(expectedReward(1, elapsed));
    });

    it('reports zero pending for an id that is not staked', async () => {
      const { staking } = await loadFixture(fundedFixture);
      expect(await staking.pendingReward(1)).to.equal(0);
    });

    it('sums pending reward across every id a user has staked', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const t1 = await stakeAt({ staking } as Ctx, alice, 1);
      const t2 = await stakeAt({ staking } as Ctx, alice, 2);
      const target = t2 + DAY;
      await time.increaseTo(Number(target));

      const expectedTotal = expectedReward(0, target - t1) + expectedReward(1, target - t2);
      expect(await staking.pendingRewardOf(alice.address)).to.equal(expectedTotal);
    });

    it('truncates a window too short to earn one base unit', async () => {
      const { staking, alice } = await loadFixture(tinyRateFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.increaseTo(Number(stakedAt + 10n)); // 100 * 10 / 86400 == 0
      expect(await staking.pendingReward(1)).to.equal(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('claiming', () => {
    it('pays the exact accrued amount and resets the checkpoint', async () => {
      const { staking, token, stakingAddress, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const elapsed = DAY;
      const expected = expectedReward(0, elapsed);

      await time.setNextBlockTimestamp(Number(stakedAt + elapsed));
      await expect(staking.connect(alice).claim(1)).to.changeTokenBalances(
        token,
        [alice.address, stakingAddress],
        [expected, -expected]
      );

      expect(await staking.pendingReward(1)).to.equal(0);
      expect(await staking.totalRewardsPaid()).to.equal(expected);
      expect(await staking.isStaked(1)).to.equal(true);
    });

    it('emits RewardClaimed with the paid amount', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.setNextBlockTimestamp(Number(stakedAt + DAY));
      await expect(staking.connect(alice).claim(1))
        .to.emit(staking, 'RewardClaimed')
        .withArgs(alice.address, 1, expectedReward(0, DAY), stakedAt + DAY);
    });

    it('does not pay twice for the same window', async () => {
      const { staking, token, stakingAddress, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.setNextBlockTimestamp(Number(stakedAt + DAY));
      await staking.connect(alice).claim(1);

      // The second claim can only land once the cooldown has expired, and it
      // must pay for that window only — never again for the first day.
      const second = stakedAt + DAY + COOLDOWN;
      await time.setNextBlockTimestamp(Number(second));
      const expected = expectedReward(0, COOLDOWN);
      await expect(staking.connect(alice).claim(1)).to.changeTokenBalances(
        token,
        [alice.address, stakingAddress],
        [expected, -expected]
      );
    });

    it('reverts rather than part-paying when the pool is short', async () => {
      const { staking, token, stakingAddress, owner, alice } = await loadFixture(unfundedFixture);
      const dust = ethers.parseUnits('1', DECIMALS);
      await token.mint(owner.address, dust);
      await token.approve(stakingAddress, dust);
      await staking.fundRewards(dust);

      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.setNextBlockTimestamp(Number(stakedAt + DAY));
      await expect(staking.connect(alice).claim(1))
        .to.be.revertedWithCustomError(staking, 'InsufficientRewardPool')
        .withArgs(expectedReward(0, DAY), dust);
    });

    it('rejects a claim from someone who is not the staker', async () => {
      const { staking, alice, bob } = await loadFixture(fundedFixture);
      await staking.connect(alice).stake(1, LOCK);
      await time.increase(DAY);
      await expect(staking.connect(bob).claim(1))
        .to.be.revertedWithCustomError(staking, 'NotStaker')
        .withArgs(1, bob.address);
    });

    it('rejects a claim on an id that is not staked', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).claim(1))
        .to.be.revertedWithCustomError(staking, 'NotStaked')
        .withArgs(1);
    });

    it('settles a batch with a single aggregate transfer', async () => {
      const { staking, token, stakingAddress, alice } = await loadFixture(fundedFixture);
      const ids = [1, 2, 3];
      const checkpoints: bigint[] = [];
      for (const id of ids) checkpoints.push(await stakeAt({ staking } as Ctx, alice, id));

      const target = checkpoints[2] + DAY;
      await time.setNextBlockTimestamp(Number(target));

      const expected = ids.reduce(
        (sum, id, i) => sum + expectedReward(tierOf(id), target - checkpoints[i]),
        0n
      );

      const tx = await staking.connect(alice).claimBatch(ids);
      const receipt = await tx.wait();

      // Exactly one ERC-20 Transfer, regardless of the number of tokens claimed.
      const transferTopic = token.interface.getEvent('Transfer')!.topicHash;
      const transfers = receipt!.logs.filter(
        log => log.address === (token.target as string) && log.topics[0] === transferTopic
      );
      expect(transfers.length).to.equal(1);

      await expect(tx).to.emit(staking, 'RewardBatchClaimed').withArgs(alice.address, 3, expected);
      expect(await token.balanceOf(alice.address)).to.equal(expected);
      expect(await staking.rewardTokenBalance()).to.equal(POOL - expected);
      void stakingAddress;
    });

    it('fails a whole batch that contains someone else’s id', async () => {
      const { staking, alice, bob } = await loadFixture(fundedFixture);
      await staking.connect(alice).stake(1, LOCK);
      await staking.connect(bob).stake(61, LOCK);
      await time.increase(DAY);
      await expect(staking.connect(alice).claimBatch([1, 61]))
        .to.be.revertedWithCustomError(staking, 'NotStaker')
        .withArgs(61, alice.address);
    });

    it('enforces the batch bounds on claimBatch', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).claimBatch([])).to.be.revertedWithCustomError(
        staking,
        'EmptyBatch'
      );
      const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1);
      await expect(staking.connect(alice).claimBatch(tooMany))
        .to.be.revertedWithCustomError(staking, 'BatchTooLarge')
        .withArgs(MAX_BATCH + 1, MAX_BATCH);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('unstaking', () => {
    it('returns the NFT, clears the record and pays the reward', async () => {
      const { staking, nft, token, stakingAddress, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const target = stakedAt + LOCK;
      const expected = expectedReward(0, LOCK);

      await time.setNextBlockTimestamp(Number(target));
      await expect(staking.connect(alice).unstake(1))
        .to.emit(staking, 'Unstaked')
        .withArgs(alice.address, 1, expected, target);

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await staking.isStaked(1)).to.equal(false);
      expect(await staking.totalStaked()).to.equal(0);
      expect(await staking.stakedBalanceOf(alice.address)).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(expected);
      void stakingAddress;
    });

    it('rejects an unstake from someone who is not the staker', async () => {
      const { staking, alice, bob } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.increaseTo(Number(stakedAt + LOCK));
      await expect(staking.connect(bob).unstake(1))
        .to.be.revertedWithCustomError(staking, 'NotStaker')
        .withArgs(1, bob.address);
    });

    it('rejects an unstake of an id that is not staked', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).unstake(1))
        .to.be.revertedWithCustomError(staking, 'NotStaked')
        .withArgs(1);
    });

    it('still returns the NFT when the pool cannot pay, recording the debt', async () => {
      const { staking, nft, alice } = await loadFixture(unfundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const target = stakedAt + LOCK;
      const expected = expectedReward(0, LOCK);

      await time.setNextBlockTimestamp(Number(target));
      await expect(staking.connect(alice).unstake(1))
        .to.emit(staking, 'RewardDeferred')
        .withArgs(alice.address, 1, expected);

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await staking.owedRewards(alice.address)).to.equal(expected);
    });

    it('pays a recorded debt once the pool is funded', async () => {
      const { staking, token, stakingAddress, owner, alice } = await loadFixture(unfundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.setNextBlockTimestamp(Number(stakedAt + LOCK));
      await staking.connect(alice).unstake(1);

      const owed: bigint = await staking.owedRewards(alice.address);
      expect(owed).to.be.greaterThan(0n);

      await expect(staking.connect(alice).claimOwed())
        .to.be.revertedWithCustomError(staking, 'InsufficientRewardPool')
        .withArgs(owed, 0);

      await token.mint(owner.address, owed);
      await token.approve(stakingAddress, owed);
      await staking.fundRewards(owed);

      await expect(staking.connect(alice).claimOwed())
        .to.emit(staking, 'OwedRewardPaid')
        .withArgs(alice.address, owed);

      expect(await staking.owedRewards(alice.address)).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(owed);
    });

    it('reverts claimOwed when nothing is owed', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).claimOwed()).to.be.revertedWithCustomError(
        staking,
        'NothingOwed'
      );
    });

    it('unstakes a batch with one aggregate transfer and enforces the bounds', async () => {
      const { staking, nft, token, alice } = await loadFixture(fundedFixture);
      const ids = [1, 2, 3];
      const checkpoints: bigint[] = [];
      for (const id of ids) checkpoints.push(await stakeAt({ staking } as Ctx, alice, id));

      const target = checkpoints[2] + LOCK;
      await time.setNextBlockTimestamp(Number(target));

      const expected = ids.reduce(
        (sum, id, i) => sum + expectedReward(tierOf(id), target - checkpoints[i]),
        0n
      );

      const tx = await staking.connect(alice).unstakeBatch(ids);
      const receipt = await tx.wait();
      const transferTopic = token.interface.getEvent('Transfer')!.topicHash;
      const transfers = receipt!.logs.filter(
        log => log.address === (token.target as string) && log.topics[0] === transferTopic
      );
      expect(transfers.length).to.equal(1);

      for (const id of ids) expect(await nft.ownerOf(id)).to.equal(alice.address);
      expect(await staking.totalStaked()).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(expected);

      await expect(staking.connect(alice).unstakeBatch([])).to.be.revertedWithCustomError(
        staking,
        'EmptyBatch'
      );
      const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1);
      await expect(staking.connect(alice).unstakeBatch(tooMany))
        .to.be.revertedWithCustomError(staking, 'BatchTooLarge')
        .withArgs(MAX_BATCH + 1, MAX_BATCH);
    });

    it('keeps the staked-id list consistent when a middle entry is removed', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await staking.connect(alice).stakeBatch([1, 2, 3], LOCK);
      await time.increase(LOCK);
      await staking.connect(alice).unstake(2);

      const ids = (await staking.getStakedTokenIds(alice.address)).map(Number);
      expect(ids.sort((a: number, b: number) => a - b)).to.deep.equal([1, 3]);

      // Both survivors must still be individually unstakeable (index integrity).
      await staking.connect(alice).unstake(1);
      await staking.connect(alice).unstake(3);
      expect(await staking.stakedBalanceOf(alice.address)).to.equal(0);
      expect(await staking.totalStaked()).to.equal(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('pause', () => {
    it('blocks new deposits but never traps a staked NFT', async () => {
      const { staking, nft, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await staking.connect(alice).stake(2, LOCK);

      await staking.pause();
      expect(await staking.paused()).to.equal(true);

      await expect(staking.connect(alice).stake(3, LOCK)).to.be.revertedWithCustomError(
        staking,
        'EnforcedPause'
      );
      await expect(staking.connect(alice).stakeBatch([3, 4], LOCK)).to.be.revertedWithCustomError(
        staking,
        'EnforcedPause'
      );

      // Pausing must not delay a settlement: claiming and unstaking stay open,
      // subject only to the cooldown and the lock the staker committed to.
      await time.setNextBlockTimestamp(Number(stakedAt + LOCK + 100n));
      await expect(staking.connect(alice).claim(1)).to.emit(staking, 'RewardClaimed');
      await expect(staking.connect(alice).unstake(2)).to.emit(staking, 'Unstaked');
      expect(await nft.ownerOf(2)).to.equal(alice.address);

      await staking.unpause();
      await expect(staking.connect(alice).stake(3, LOCK)).to.emit(staking, 'Staked');
    });

    it('is owner-only', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).pause()).to.be.revertedWithCustomError(
        staking,
        'OwnableUnauthorizedAccount'
      );
      await staking.pause();
      await expect(staking.connect(alice).unpause()).to.be.revertedWithCustomError(
        staking,
        'OwnableUnauthorizedAccount'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('admin cannot take user NFTs', () => {
    it('exposes no withdraw/rescue/sweep entry point', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const names = staking.interface.fragments
        .filter(f => f.type === 'function')
        .map(f => (f as { name: string }).name);

      const forbidden = /withdraw|rescue|sweep|emergency|migrate|recover|transferNft|setNft|setReward(Token)?Address/i;
      const offenders = names.filter(n => forbidden.test(n) && n !== 'claimOwed');
      expect(offenders, `unexpected admin escape hatch: ${offenders.join(', ')}`).to.deep.equal([]);
    });

    it('leaves the owner with no way to move an escrowed NFT', async () => {
      const { staking, nft, stakingAddress, owner, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await time.increaseTo(Number(stakedAt + LOCK));

      // The owner is not approved on the collection and is not the holder.
      expect(await nft.ownerOf(1)).to.equal(stakingAddress);
      await expect(
        nft.connect(owner).transferFrom(stakingAddress, owner.address, 1)
      ).to.be.revertedWithCustomError(nft, 'ERC721InsufficientApproval');

      // Only the staker can pull it back.
      await expect(staking.connect(owner).unstake(1))
        .to.be.revertedWithCustomError(staking, 'NotStaker')
        .withArgs(1, owner.address);
      await staking.connect(alice).unstake(1);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('accounting totals', () => {
    it('tracks totalStaked and totalRewardsPaid across mixed activity', async () => {
      const { staking, alice, bob } = await loadFixture(fundedFixture);
      await staking.connect(alice).stakeBatch([1, 2], LOCK);
      await staking.connect(bob).stake(61, LOCK);
      expect(await staking.totalStaked()).to.equal(3);

      await time.increase(LOCK);
      await staking.connect(alice).claim(1);
      const paidAfterClaim: bigint = await staking.totalRewardsPaid();
      expect(paidAfterClaim).to.be.greaterThan(0n);

      await staking.connect(bob).unstake(61);
      expect(await staking.totalStaked()).to.equal(2);
      expect(await staking.totalRewardsPaid()).to.be.greaterThan(paidAfterClaim);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('lock duration', () => {
    it('rejects a lock shorter than the minimum', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);

      for (const bad of [0n, 1n, MIN_LOCK - 1n]) {
        await expect(staking.connect(alice).stake(1, bad))
          .to.be.revertedWithCustomError(staking, 'InvalidLockDuration')
          .withArgs(bad, MIN_LOCK, MAX_LOCK);
      }
      expect(await staking.totalStaked()).to.equal(0);
    });

    it('rejects a lock longer than the maximum', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).stake(1, MAX_LOCK + 1n))
        .to.be.revertedWithCustomError(staking, 'InvalidLockDuration')
        .withArgs(MAX_LOCK + 1n, MIN_LOCK, MAX_LOCK);
    });

    it('accepts both boundaries exactly', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);

      const t1 = await stakeAt({ staking } as Ctx, alice, 1, MIN_LOCK);
      const t2 = await stakeAt({ staking } as Ctx, alice, 2, MAX_LOCK);

      expect(await staking.unlockTimeOf(1)).to.equal(t1 + MIN_LOCK);
      expect(await staking.unlockTimeOf(2)).to.equal(t2 + MAX_LOCK);
      expect(await staking.totalStaked()).to.equal(2);
    });

    it('validates the lock before any id is escrowed in a batch', async () => {
      const { staking, nft, alice } = await loadFixture(fundedFixture);
      await expect(staking.connect(alice).stakeBatch([1, 2], MIN_LOCK - 1n))
        .to.be.revertedWithCustomError(staking, 'InvalidLockDuration')
        .withArgs(MIN_LOCK - 1n, MIN_LOCK, MAX_LOCK);

      expect(await staking.totalStaked()).to.equal(0);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it('refuses an unstake before the committed unlock time', async () => {
      const { staking, nft, stakingAddress, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const unlockAt = stakedAt + LOCK;

      expect(await staking.isUnlocked(1)).to.equal(false);

      // One block short of the unlock: the next block lands before `unlockAt`.
      await time.increaseTo(Number(unlockAt - 100n));
      await expect(staking.connect(alice).unstake(1))
        .to.be.revertedWithCustomError(staking, 'StakeLocked')
        .withArgs(1, unlockAt);
      expect(await nft.ownerOf(1)).to.equal(stakingAddress);
    });

    it('releases the NFT once the unlock time is reached', async () => {
      const { staking, nft, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const unlockAt = stakedAt + LOCK;

      await time.increaseTo(Number(unlockAt));
      expect(await staking.isUnlocked(1)).to.equal(true);
      expect((await staking.unlockedTokenIdsOf(alice.address)).map(Number)).to.deep.equal([1]);

      await staking.connect(alice).unstake(1);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it('keeps the lock in force while the contract is paused', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await staking.pause();

      await time.increaseTo(Number(stakedAt + DAY));
      await expect(staking.connect(alice).unstake(1))
        .to.be.revertedWithCustomError(staking, 'StakeLocked')
        .withArgs(1, stakedAt + LOCK);
    });

    it('fails a whole unstake batch when one id is still locked', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const t1 = await stakeAt({ staking } as Ctx, alice, 1, MIN_LOCK);
      const t2 = await stakeAt({ staking } as Ctx, alice, 2, MIN_LOCK * 2n);

      await time.increaseTo(Number(t1 + MIN_LOCK));
      await expect(staking.connect(alice).unstakeBatch([1, 2]))
        .to.be.revertedWithCustomError(staking, 'StakeLocked')
        .withArgs(2, t2 + MIN_LOCK * 2n);
      expect(await staking.totalStaked()).to.equal(2);
    });

    it('reports the lock window and cooldown through lockBounds', async () => {
      const { staking } = await loadFixture(fundedFixture);
      const [minDuration, maxDuration, cooldown] = await staking.lockBounds();
      expect(minDuration).to.equal(MIN_LOCK);
      expect(maxDuration).to.equal(MAX_LOCK);
      expect(cooldown).to.equal(COOLDOWN);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('claim cooldown', () => {
    it('refuses a claim inside the 24h window', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const nextClaimAt = stakedAt + COOLDOWN;

      expect(await staking.canClaim(1)).to.equal(false);
      expect(await staking.nextClaimTimeOf(1)).to.equal(nextClaimAt);

      await expect(staking.connect(alice).claim(1))
        .to.be.revertedWithCustomError(staking, 'ClaimCooldownActive')
        .withArgs(1, nextClaimAt);

      await time.increaseTo(Number(nextClaimAt - 100n));
      await expect(staking.connect(alice).claim(1))
        .to.be.revertedWithCustomError(staking, 'ClaimCooldownActive')
        .withArgs(1, nextClaimAt);
    });

    it('allows a claim exactly on the cooldown boundary', async () => {
      const { staking, token, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);

      await time.setNextBlockTimestamp(Number(stakedAt + COOLDOWN));
      await staking.connect(alice).claim(1);

      expect(await token.balanceOf(alice.address)).to.equal(expectedReward(0, COOLDOWN));
      expect(await staking.canClaim(1)).to.equal(false);
    });

    it('defers payment without reducing what is owed', async () => {
      const { staking, token, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);

      // One claim after three days pays the full three days.
      await time.setNextBlockTimestamp(Number(stakedAt + 3n * DAY));
      await staking.connect(alice).claim(1);
      expect(await token.balanceOf(alice.address)).to.equal(expectedReward(0, 3n * DAY));
    });

    it('pays the same total whether claimed daily or once', async () => {
      const { staking, token, alice, bob } = await loadFixture(fundedFixture);
      const aliceStart = await stakeAt({ staking } as Ctx, alice, 1); // tier 0
      const bobStart = await stakeAt({ staking } as Ctx, bob, 66); // tier 0 as well

      for (let day = 1n; day <= 3n; day++) {
        await time.setNextBlockTimestamp(Number(aliceStart + day * DAY));
        await staking.connect(alice).claim(1);
      }

      await time.setNextBlockTimestamp(Number(bobStart + 3n * DAY));
      await staking.connect(bob).claim(66);

      expect(tierOf(66)).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(expectedReward(0, 3n * DAY));
      expect(await token.balanceOf(bob.address)).to.equal(await token.balanceOf(alice.address));
    });

    it('fails a whole claim batch when one id is still cooling down', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      await staking.connect(alice).stake(2, LOCK);

      await time.increaseTo(Number(stakedAt + COOLDOWN + 10n));
      const receipt = await (await staking.connect(alice).claim(1)).wait();
      const claimedAt = BigInt(
        (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp
      );

      await expect(staking.connect(alice).claimBatch([1, 2]))
        .to.be.revertedWithCustomError(staking, 'ClaimCooldownActive')
        .withArgs(1, claimedAt + COOLDOWN);
    });

    it('separates "earned" from "claimable now"', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      const t1 = await stakeAt({ staking } as Ctx, alice, 1); // tier 0
      const t2 = await stakeAt({ staking } as Ctx, alice, 2); // tier 1, staked later

      await time.increaseTo(Number(t1 + COOLDOWN));

      const claimableNow = expectedReward(0, COOLDOWN);
      const stillCooling = expectedReward(1, t1 + COOLDOWN - t2);

      expect(await staking.claimableRewardOf(alice.address)).to.equal(claimableNow);
      expect(await staking.pendingRewardOf(alice.address)).to.equal(claimableNow + stillCooling);
      expect((await staking.claimableTokenIdsOf(alice.address)).map(Number)).to.deep.equal([1]);
      expect(await staking.canClaim(2)).to.equal(false);
    });

    it('lets an unstake settle without waiting out the cooldown', async () => {
      const { staking, token, nft, alice } = await loadFixture(fundedFixture);
      const stakedAt = await stakeAt({ staking } as Ctx, alice, 1);
      const unlockAt = stakedAt + LOCK;

      // Claim shortly before the unlock, then close the position immediately
      // after it: the cooldown rate-limits claims, it must never trap an NFT.
      await time.setNextBlockTimestamp(Number(unlockAt - 100n));
      await staking.connect(alice).claim(1);
      const claimed = expectedReward(0, LOCK - 100n);

      await time.setNextBlockTimestamp(Number(unlockAt));
      await staking.connect(alice).unstake(1);

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(claimed + expectedReward(0, 100n));
    });

    it('reports the aggregate reward rate per second', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      await staking.connect(alice).stakeBatch([1, 2, 3], LOCK);
      const expectedRate = RATES[0] / DAY + RATES[1] / DAY + RATES[2] / DAY;
      expect(await staking.rewardRateOf(alice.address)).to.equal(expectedRate);
    });

    it('reports zeroed lock and cooldown views for an id that is not staked', async () => {
      const { staking, alice } = await loadFixture(fundedFixture);
      expect(await staking.unlockTimeOf(1)).to.equal(0);
      expect(await staking.nextClaimTimeOf(1)).to.equal(0);
      expect(await staking.isUnlocked(1)).to.equal(false);
      expect(await staking.canClaim(1)).to.equal(false);
      expect(await staking.claimableRewardOf(alice.address)).to.equal(0);
      expect(await staking.rewardRateOf(alice.address)).to.equal(0);

      const info = await staking.getStakeInfo(1);
      expect(info[0]).to.equal(ethers.ZeroAddress);
      for (let i = 1; i < 8; i++) expect(info[i]).to.equal(0);
    });
  });
});
