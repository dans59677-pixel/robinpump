'use strict';

/*
 * RobinPump Green Flock — Staking UI
 *
 * Source of truth: Robinhood Chain (chain ID 4663).
 * No NFT ownership, staking state, reward, or transaction state is persisted
 * in localStorage, sessionStorage, or any browser-side database.
 *
 * Staking transactions stay disabled until BOTH `enabled` is true and
 * `stakingContract` is set in staking-config.js.
 */

// ── Config guard ─────────────────────────────────────────────────────────────
const CFG = window.RobinPumpStakingConfig;
if (!CFG) {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('runtimeStatus');
    if (el) {
      el.textContent = 'Configuration failed to load. Reload the page to try again.';
      el.hidden = false;
    }
  });
  throw new Error('RobinPumpStakingConfig missing — staking-config.js did not load.');
}

const EXPLORER = CFG.network.explorerUrl;
const TOKEN_DECIMALS = CFG.rewardToken.decimals;
const DAY_SECONDS = 86_400;
// Mirrors TIER_COUNT in RobinPumpNFTStaking.sol (0 = Legendary … 4 = Common).
const TIER_COUNT = 5;
// Mirrors MAX_BATCH_SIZE — any longer array argument reverts on-chain.
const MAX_BATCH_SIZE = 50;
// Both gates must be satisfied before any transaction path is exposed.
const STAKING_ACTIVE = !!(CFG.enabled && CFG.stakingContract);

// ── Demo / preview mode ─────────────────────────────────────────────────────
// Explicit opt-in only: staking.html?demo=1. It is never derived from config
// state and never used as a fallback when a wallet or RPC is missing, so the
// live transaction path can never silently degrade into the simulation.
const DEMO_MODE = (() => {
  try { return new URLSearchParams(window.location.search).get('demo') === '1'; }
  catch { return false; }
})();

// Controls only whether the stake/claim/unstake controls are rendered at all.
// Every real transaction still checks STAKING_ACTIVE, and sendTx() throws if it
// is ever reached while DEMO_MODE is on.
const UI_STAKING_ENABLED = STAKING_ACTIVE || DEMO_MODE;

// ── Selector helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const show = id => { const el = $(id); if (el) el.hidden = false; };
const hide = id => { const el = $(id); if (el) el.hidden = true; };
const toggle = (id, visible) => { const el = $(id); if (el) el.hidden = !visible; };

// ── State ────────────────────────────────────────────────────────────────────
let account = null;
let detectedChainId = null;
let nftData = [];          // [{tokenId, metadata, tier, staked, stake}]
let refreshLock = false;
let activeTab = 'available';

// Live-reward bookkeeping. stakeIndex maps tokenId → the record read from the
// staking contract; the 1s ticker replays accrual locally between RPC reads.
let stakeIndex = new Map();
let walletRatePerSecond = 0n;
let tickerId = null;

/*
 * Reward pool awareness.
 *
 * The staking contract never mints: claim() pays out of
 * rewardToken.balanceOf(stakingContract) and reverts with
 * InsufficientRewardPool the moment the settled amount exceeds it. So the UI
 * reads that balance on every refresh and treats it as a hard ceiling on what
 * it advertises as claimable — an accrued figure the pool cannot pay is not a
 * claimable figure.
 *
 * `null` means "not read yet" and is deliberately distinct from 0n ("read, and
 * the pool is empty"): an unread pool must never be rendered as a shortfall.
 */
let rewardPoolBalance = null;
// owedRewards(account): the credit unstake() books when the pool was short at
// settlement time. Withdrawn separately via claimOwed().
let owedRewards = 0n;

/*
 * Rarity gate awareness.
 *
 * _stake() reads _tierPlusOne[tokenId] and reverts with
 * TierNotConfigured(tokenId) when it is still 0. That revert happens before the
 * NFT is transferred, so an unconfigured id can never be stranded in the
 * contract — but ensureApproval() sends approve() first, and that transaction
 * succeeds and costs real gas before the doomed stake() is even attempted.
 *
 * unconfiguredTokenIds(uint256[]) is a view, so asking the chain which of the
 * wallet's ids are still unwritten is a free eth_call. Holding the answer here
 * lets the card disable Stake up front, so nobody pays approve gas for a stake
 * that cannot succeed.
 *
 * `null` means "not read yet" and is deliberately distinct from an empty Set
 * ("read, and every id is configured"): an unread gate must never be rendered
 * as a blocker.
 */
let unconfiguredIds = null;

// True only when the chain has been asked and answered.
function tierGateKnown() {
  return unconfiguredIds instanceof Set;
}

// Unknown gate → not blocked. The contract still refuses the stake, and
// REVERT_MESSAGES renders TierNotConfigured in plain language if it happens.
function isTierPending(tokenId) {
  return tierGateKnown() && unconfiguredIds.has(String(tokenId));
}

// One wallet transaction at a time — prevents double-spend clicks and
// overlapping approve/stake sequences.
let txPending = false;

// Lock picker state (which token the modal is staking, and the chosen term).
let lockModalTokenId = null;
let lockDays = 7;
let lockReturnFocus = null;

// Countdowns are measured against block.timestamp, never the user's system
// clock, so a skewed local clock can never unlock a card early.
let chainClock = { chainNow: Math.floor(Date.now() / 1000), readAt: Date.now() };

// Display defaults, taken from config where present so the lock picker can
// render before the first RPC. Overwritten by lockBounds() on read — the
// contract is the only authority on these numbers.
let lockLimits = {
  min:      CFG.lockRules?.minSeconds           || 7 * DAY_SECONDS,
  max:      CFG.lockRules?.maxSeconds           || 1095 * DAY_SECONDS,
  cooldown: CFG.lockRules?.claimCooldownSeconds || DAY_SECONDS
};

// ── Tier config (display/estimation only — contract is authoritative) ────────
const TIER_CONFIG = Object.freeze({
  LEGENDARY: { label: 'Legendary', ratePerDay: 1000,       cssClass: 'tier-legendary', rewardBasis: 1 },
  EPIC:      { label: 'Epic',      ratePerDay: 333.333333, cssClass: 'tier-epic',      rewardBasis: 3 },
  RARE:      { label: 'Rare',      ratePerDay: 111.111111, cssClass: 'tier-rare',      rewardBasis: 9 },
  UNCOMMON:  { label: 'Uncommon',  ratePerDay: 37.037037,  cssClass: 'tier-uncommon',  rewardBasis: 27 },
  COMMON:    { label: 'Common',    ratePerDay: 12.345679,  cssClass: 'tier-common',    rewardBasis: 81 }
});

// Reward per day per tier, in reward-token base units, indexed by tier number.
// Seeded from the display table so the first paint is not blank; overwritten by
// rewardPerDay(uint256) on read — the contract is the only authority.
let tierRatePerDay = Object.values(TIER_CONFIG).map(t => toBaseUnits(t.ratePerDay));

// ── Utilities ─────────────────────────────────────────────────────────────────
// Decimal string/number → base units without ever going through a float.
function toBaseUnits(amount) {
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS);
  return BigInt((whole || '0') + padded);
}

function formatUnits(value, decimals, maxFrac = 6) {
  try {
    const base = 10n ** BigInt(decimals);
    const amount = BigInt(value);
    const whole = amount / base;
    const frac = (amount % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
    const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac}` : grouped;
  } catch { return '—'; }
}

function shortAddress(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

function encodeAddr(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function decodeString(data) {
  if (!data || data === '0x') return '';
  try {
    const offset = Number(BigInt(`0x${data.slice(2, 66)}`)) * 2;
    const ls = 2 + offset;
    const length = Number(BigInt(`0x${data.slice(ls, ls + 64)}`));
    const hex = data.slice(ls + 64, ls + 64 + length * 2);
    return new TextDecoder().decode(
      Uint8Array.from(hex.match(/.{1,2}/g) || [], b => parseInt(b, 16))
    );
  } catch { return ''; }
}

// Only ipfs:// and https:// are allowed to reach the DOM as image sources.
function toGateway(uri) {
  if (typeof uri !== 'string' || !uri) return '';
  const trimmed = uri.trim();
  if (trimmed.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${trimmed.slice(7)}`;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  return '';
}

function getTierFromMetadata(metadata) {
  const attrs = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
  const trait = attrs.find(a => /^(tier|rarity)$/i.test(String(a?.trait_type || '')));
  const key = String(trait?.value || '').trim().toUpperCase();
  return TIER_CONFIG[key] ? key : null;
}

// ── Time formatting ───────────────────────────────────────────────────────────
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(s / DAY_SECONDS);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const rest = days % 365;
    return rest ? `${years}y ${rest}d` : `${years} year${years > 1 ? 's' : ''}`;
  }
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  const hours = Math.floor(s / 3600);
  if (hours >= 1) return `${hours}h ${Math.floor((s % 3600) / 60)}m`;
  const minutes = Math.floor(s / 60);
  return minutes >= 1 ? `${minutes}m ${s % 60}s` : `${s}s`;
}

function formatCountdown(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s <= 0) return 'Ready';
  if (s >= DAY_SECONDS) {
    return `${Math.floor(s / DAY_SECONDS)}d ${Math.floor((s % DAY_SECONDS) / 3600)}h`;
  }
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatTimestamp(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// ── keccak-256 ────────────────────────────────────────────────────────────────
// Function selectors are derived at runtime from their canonical signatures so
// a contract change can never silently desync from a hardcoded 4-byte hash.
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
// Rho rotation offsets, indexed [x][y].
const KECCAK_RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];

function rotl64(value, shift) {
  if (shift === 0) return value & MASK64;
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK64;
}

function keccakF1600(A) {
  for (let round = 0; round < 24; round++) {
    // θ
    const C = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
    const D = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];

    // ρ and π
    const B = [[], [], [], [], []];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y][(2 * x + 3 * y) % 5] = rotl64(A[x][y], KECCAK_RHO[x][y]);
      }
    }
    // χ
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & MASK64) & B[(x + 2) % 5][y]);
      }
    }
    // ι
    A[0][0] ^= KECCAK_RC[round];
  }
}

function keccak256Hex(message) {
  const RATE = 136; // 1088 bits, the Keccak-256 rate
  const bytes = new TextEncoder().encode(message);

  // Original Keccak padding (0x01 … 0x80), which is what Ethereum uses.
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = [[], [], [], [], []];
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = 0n;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(padded[offset + lane * 8 + b]);
      A[lane % 5][(lane - (lane % 5)) / 5] ^= value;
    }
    keccakF1600(A);
  }

  let out = '';
  for (let lane = 0; lane < 4; lane++) {          // 4 lanes = 32 bytes
    const value = A[lane % 5][(lane - (lane % 5)) / 5];
    for (let b = 0; b < 8; b++) {
      out += Number((value >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
    }
  }
  return out;
}

function selector(signature) {
  return `0x${keccak256Hex(signature).slice(0, 8)}`;
}

// Every signature here is taken verbatim from
// robinpump-staking/frontend-abi/RobinPumpNFTStaking.json. A single character of
// drift changes the selector, and the transaction would revert on-chain.
const SEL = Object.freeze({
  // ERC-721 (collection)
  getApproved:        selector('getApproved(uint256)'),
  approve:            selector('approve(address,uint256)'),
  isApprovedForAll:   selector('isApprovedForAll(address,address)'),
  // Staking contract — writes
  stake:              selector('stake(uint256,uint256)'),
  unstake:            selector('unstake(uint256)'),
  claim:              selector('claim(uint256)'),
  claimBatch:         selector('claimBatch(uint256[])'),
  claimOwed:          selector('claimOwed()'),
  // Staking contract — reads
  getStakedTokenIds:  selector('getStakedTokenIds(address)'),
  getStakeInfo:       selector('getStakeInfo(uint256)'),
  rewardPerDay:       selector('rewardPerDay(uint256)'),
  rewardRateOf:       selector('rewardRateOf(address)'),
  claimableRewardOf:  selector('claimableRewardOf(address)'),
  lockBounds:         selector('lockBounds()'),
  rewardTokenBalance: selector('rewardTokenBalance()'),
  owedRewards:        selector('owedRewards(address)'),
  /*
   * Returns the subset of the given ids whose tier has not been written yet.
   * A view, so this costs nothing — and it is the only way for the UI to know
   * which ids stake() would reject before the holder spends approve gas.
   */
  unconfiguredTokenIds: selector('unconfiguredTokenIds(uint256[])')
});

// ── ABI encode / decode ───────────────────────────────────────────────────────
function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

// Encodes a single top-level uint256[] argument: head offset, length, elements.
function encodeUintArray(values) {
  return encodeUint(32) + encodeUint(values.length) + values.map(encodeUint).join('');
}

function wordAt(data, index) {
  const start = 2 + index * 64;
  const slice = String(data).slice(start, start + 64);
  return slice.length === 64 ? `0x${slice}` : '0x0';
}

function decodeUintAt(data, index) {
  return decodeUint(wordAt(data, index));
}

function decodeAddressAt(data, index) {
  return `0x${wordAt(data, index).slice(-40)}`.toLowerCase();
}

// Decodes a dynamic uint256[] return value (single top-level array).
function decodeUintArray(data) {
  if (!data || data === '0x') return [];
  const offsetWords = Number(decodeUintAt(data, 0)) / 32;
  const length = Number(decodeUintAt(data, offsetWords));
  const out = [];
  for (let i = 0; i < length; i++) out.push(decodeUintAt(data, offsetWords + 1 + i));
  return out;
}

// ── RPC helpers ───────────────────────────────────────────────────────────────
async function rpc(method, params = []) {
  if (!window.ethereum) throw new Error('No EVM wallet detected. Please install MetaMask or a compatible wallet.');
  return window.ethereum.request({ method, params });
}

async function call(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

function normaliseChainId(chainId) {
  try { return BigInt(chainId); } catch { return null; }
}

function isRobinhoodChain(chainId) {
  const actual = normaliseChainId(chainId);
  return actual !== null && actual === BigInt(CFG.network.chainId);
}

function describeChain(chainId) {
  const normalised = normaliseChainId(chainId);
  return normalised === null ? 'Unknown network' : `Chain ID: ${normalised.toString()}`;
}

// ── Header wallet chip ────────────────────────────────────────────────────────
function renderWalletChip() {
  const chip = $('walletInfo');
  const button = $('connectWalletNav');
  const connected = !!account;

  if (button) {
    button.textContent = connected ? 'Disconnect' : 'Connect Wallet';
    button.setAttribute('aria-label', connected ? 'Disconnect wallet from RobinPump' : 'Connect wallet');
    button.classList.toggle('btn-outline', connected);
    button.classList.toggle('btn-primary', !connected);
  }
  if (!chip) return;

  chip.hidden = !connected;
  if (!connected) return;

  const onChain = isRobinhoodChain(detectedChainId);
  chip.classList.toggle('wallet-chip--wrong', !onChain);
  setText('walletNetworkLabel', onChain ? CFG.network.label : describeChain(detectedChainId));
  setText('walletShort', shortAddress(account));

  const copyBtn = $('walletCopyBtn');
  if (copyBtn) copyBtn.title = account;
}

function updateDetectedNetwork(chainId) {
  detectedChainId = chainId;
  const isExpected = isRobinhoodChain(chainId);
  setText('detectedNetworkText', isExpected
    ? `${CFG.network.label} detected. Refreshing your on-chain Green Flock data…`
    : `Your wallet is connected to ${describeChain(chainId)}. Switch to ${CFG.network.label} (Chain ID: ${CFG.network.chainId}) to view your Green Flock NFTs.`);
  renderWalletChip();
}

// ── Single-state view switcher ────────────────────────────────────────────────
// Exactly one of these panels is ever visible, which is what keeps the page
// from stacking the connect card on top of the wrong-network card.
function setView(state) {
  toggle('connectPrompt',     state === 'connect');
  toggle('wrongNetworkPrompt', state === 'wrongNetwork');
  toggle('stakingDashboard',  state === 'dashboard');
}

// ── Chain management ──────────────────────────────────────────────────────────
async function ensureRobinhoodChain() {
  const current = await rpc('eth_chainId');
  updateDetectedNetwork(current);
  if (isRobinhoodChain(current)) return true;
  try {
    await rpc('wallet_switchEthereumChain', [{ chainId: CFG.network.chainIdHex }]);
  } catch (err) {
    if (err.code !== 4902) throw err;
    // The wallet tries rpcUrls in order, so the whole public list is passed
    // through. Wallets reject the call outright if the array is empty.
    await rpc('wallet_addEthereumChain', [{
      chainId: CFG.network.chainIdHex,
      chainName: CFG.network.label,
      nativeCurrency: { name: 'Ether', symbol: CFG.network.currencySymbol, decimals: 18 },
      rpcUrls: [...CFG.network.rpcUrls],
      blockExplorerUrls: [CFG.network.explorerUrl]
    }]);
  }
  const switched = await rpc('eth_chainId');
  updateDetectedNetwork(switched);
  if (!isRobinhoodChain(switched)) throw new Error(`Wallet remained on ${describeChain(switched)}.`);
  return true;
}

// ── NFT ownership via Transfer event logs ─────────────────────────────────────
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LOG_CHUNK = 50_000n;   // most public RPCs cap the block span per request

async function getLogsChunked(filter, latestBlock) {
  const out = [];
  let span = LOG_CHUNK;
  let from = 0n;

  while (from <= latestBlock) {
    const to = from + span - 1n > latestBlock ? latestBlock : from + span - 1n;
    try {
      const logs = await rpc('eth_getLogs', [{
        ...filter,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`
      }]);
      out.push(...logs);
      from = to + 1n;
    } catch (err) {
      // Range too wide or too many results — halve and retry the same window.
      if (span <= 1_000n) throw err;
      span /= 2n;
    }
  }
  return out;
}

async function getOwnedTokenIds(owner) {
  const nftAddr = CFG.greenFlockCollection.address;
  const ownerTopic = `0x${encodeAddr(owner)}`;
  const latestBlock = decodeUint(await rpc('eth_blockNumber'));

  const [incoming, outgoing] = await Promise.all([
    getLogsChunked({ address: nftAddr, topics: [TRANSFER_TOPIC, null, ownerTopic] }, latestBlock),
    getLogsChunked({ address: nftAddr, topics: [TRANSFER_TOPIC, ownerTopic] }, latestBlock)
  ]);

  // Deduplicate by tx+logIndex, then replay chronologically
  const eventMap = new Map();
  [...incoming, ...outgoing].forEach(e => eventMap.set(`${e.transactionHash}:${e.logIndex}`, e));
  const owned = new Set();
  const lower = owner.toLowerCase();

  [...eventMap.values()]
    .sort((a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex))
    )
    .forEach(e => {
      const tokenId = BigInt(e.topics[3]).toString();
      const from = `0x${e.topics[1].slice(-40)}`.toLowerCase();
      const to   = `0x${e.topics[2].slice(-40)}`.toLowerCase();
      if (to === lower)   owned.add(tokenId);
      if (from === lower) owned.delete(tokenId);
    });

  return [...owned].sort((a, b) => Number(BigInt(a) - BigInt(b)));
}

// ── Metadata fetch ─────────────────────────────────────────────────────────────
async function fetchMetadata(tokenId) {
  try {
    const data = `0xc87b56dd${BigInt(tokenId).toString(16).padStart(64, '0')}`;
    const raw = await call(CFG.greenFlockCollection.address, data);
    const uri = decodeString(raw);
    if (!uri) return null;
    if (uri.startsWith('data:application/json')) {
      const [, payload = ''] = uri.split(',', 2);
      return uri.includes(';base64,')
        ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0))))
        : JSON.parse(decodeURIComponent(payload));
    }
    const url = toGateway(uri);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Staking contract reads ─────────────────────────────────────────────────────
// Every countdown is anchored to block.timestamp, never Date.now(), so a skewed
// local clock can never render a locked NFT as unlocked.
async function refreshChainClock() {
  try {
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const ts = Number(decodeUint(block?.timestamp));
    if (ts > 0) chainClock = { chainNow: ts, readAt: Date.now() };
  } catch {
    // Keep the previous anchor rather than silently falling back to local time.
  }
}

// Last known chain time, projected forward by locally elapsed seconds.
function chainNow() {
  return chainClock.chainNow + Math.floor((Date.now() - chainClock.readAt) / 1000);
}

// getStakeInfo() returns 8 static words, so plain word indexing is enough —
// no dynamic offset handling required. Word order, straight from the ABI:
//   owner, tier, stakedAt, lastClaimAt, lockDuration, unlockAt, nextClaimAt, pending
//
// The tuple carries no rate, so `ratePerDay` is attached from the tier table.
// That is what lets the 1s ticker reproduce _pending() locally between reads.
function decodeStakeInfo(data, ratesPerDay = tierRatePerDay) {
  const tier = Number(decodeUintAt(data, 1));
  return {
    owner:        decodeAddressAt(data, 0),
    tier,
    stakedAt:     Number(decodeUintAt(data, 2)),
    lastClaimAt:  Number(decodeUintAt(data, 3)),
    lockDuration: Number(decodeUintAt(data, 4)),
    unlockAt:     Number(decodeUintAt(data, 5)),
    nextClaimAt:  Number(decodeUintAt(data, 6)),
    pending:      decodeUintAt(data, 7),
    ratePerDay:   ratesPerDay[tier] || 0n
  };
}

// rewardPerDay is a public array, so it is read one tier at a time. A partial
// read is discarded outright: a zeroed rate would silently render 0 pending.
async function readTierRates() {
  const staking = CFG.stakingContract;
  const raw = await Promise.all(
    Array.from({ length: TIER_COUNT }, (_, tier) =>
      call(staking, `${SEL.rewardPerDay}${encodeUint(tier)}`).catch(() => null))
  );
  if (raw.some(r => !r || r === '0x')) return tierRatePerDay;
  tierRatePerDay = raw.map(r => decodeUintAt(r, 0));
  return tierRatePerDay;
}

async function readStakingState(owner) {
  const staking = CFG.stakingContract;
  const records = new Map();

  // Rates are needed before the records are decoded, so they are read first.
  const [idsRaw, ratesPerDay] = await Promise.all([
    call(staking, `${SEL.getStakedTokenIds}${encodeAddr(owner)}`),
    readTierRates(),
    refreshChainClock()
  ]);
  const ids = decodeUintArray(idsRaw).map(id => id.toString());

  // One getStakeInfo read per staked token. A single failed read must not blank
  // the whole staked tab, so failures are dropped individually.
  const details = await Promise.all(
    ids.map(id => call(staking, `${SEL.getStakeInfo}${encodeUint(id)}`).catch(() => null))
  );
  ids.forEach((id, i) => {
    const raw = details[i];
    if (!raw || raw === '0x') return;
    records.set(id, decodeStakeInfo(raw, ratesPerDay));
  });

  const [rateRaw, boundsRaw, poolRaw, owedRaw] = await Promise.all([
    call(staking, `${SEL.rewardRateOf}${encodeAddr(owner)}`).catch(() => null),
    call(staking, SEL.lockBounds).catch(() => null),
    call(staking, SEL.rewardTokenBalance).catch(() => null),
    call(staking, `${SEL.owedRewards}${encodeAddr(owner)}`).catch(() => null)
  ]);

  walletRatePerSecond = rateRaw ? decodeUintAt(rateRaw, 0) : 0n;

  // A failed pool read leaves the previous value in place rather than
  // substituting 0n, which would fake a shortfall the chain never reported.
  if (poolRaw && poolRaw !== '0x') rewardPoolBalance = decodeUintAt(poolRaw, 0);
  owedRewards = owedRaw && owedRaw !== '0x' ? decodeUintAt(owedRaw, 0) : 0n;

  // The contract is authoritative for the lock window; the defaults are only a
  // fallback for when the read fails.
  if (boundsRaw && boundsRaw !== '0x') {
    lockLimits = {
      min:      Number(decodeUintAt(boundsRaw, 0)) || lockLimits.min,
      max:      Number(decodeUintAt(boundsRaw, 1)) || lockLimits.max,
      cooldown: Number(decodeUintAt(boundsRaw, 2)) || lockLimits.cooldown
    };
  }

  return { records };
}

/*
 * Which of these ids does the contract still refuse to stake?
 *
 * unconfiguredTokenIds(uint256[]) is a view, so this is an eth_call: no
 * transaction, no gas, nothing signed. Only the unstaked ids are worth asking
 * about — an already-staked id proves its tier was written.
 *
 * Chunked because the argument is unbounded calldata and public RPCs cap
 * request size. The view itself has no MAX_BATCH_SIZE check (that guard is on
 * the write paths), so the limit here is purely about the transport.
 *
 * Returns null on any failure, which is the "not read yet" signal: a gate the
 * chain never answered must not disable a button. The contract still rejects
 * the stake, and REVERT_MESSAGES explains why in plain language.
 */
const TIER_GATE_CHUNK = 200;

async function readTierGate(tokenIds) {
  if (!STAKING_ACTIVE || !CFG.stakingContract) return null;
  if (!tokenIds.length) return new Set();

  const staking = CFG.stakingContract;
  const chunks = [];
  for (let i = 0; i < tokenIds.length; i += TIER_GATE_CHUNK) {
    chunks.push(tokenIds.slice(i, i + TIER_GATE_CHUNK));
  }

  const results = await Promise.all(
    chunks.map(group =>
      call(staking, `${SEL.unconfiguredTokenIds}${encodeUintArray(group)}`).catch(() => null))
  );

  // Partial answers are discarded: a half-read gate would mark configured ids
  // as pending and hide the Stake button from holders who could actually stake.
  if (results.some(r => !r || r === '0x')) return null;

  const pending = new Set();
  results.forEach(raw => decodeUintArray(raw).forEach(id => pending.add(id.toString())));
  return pending;
}

// ── Live reward maths (mirrors _pending in RobinPumpNFTStaking.sol) ───────────
// Solidity: (rewardPerDay[tier] * (block.timestamp - lastClaimAt)) / 1 days
//
// The division is applied last, exactly as on-chain, so the ticker never drifts
// from what a claim would actually pay. `lastClaimAt` is both the accrual
// checkpoint and the cooldown anchor, so no separate checkpoint field exists.
function localPending(stake, now = chainNow()) {
  if (!stake) return 0n;
  const elapsed = BigInt(Math.max(0, now - stake.lastClaimAt));
  if (elapsed === 0n) return 0n;
  return (stake.ratePerDay * elapsed) / BigInt(DAY_SECONDS);
}

function isClaimable(stake, now = chainNow()) {
  return !!stake && now >= stake.nextClaimAt;
}

function isUnlocked(stake, now = chainNow()) {
  return !!stake && now >= stake.unlockAt;
}

// ── Toast notifications (DOM-built: no innerHTML, no injection surface) ────────
const SVG_NS = 'http://www.w3.org/2000/svg';

const TOAST_ICONS = {
  info:    ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01'],
  success: ['M20 6L9 17l-5-5'],
  error:   ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9l-6 6M9 9l6 6']
};

const ICON_EXTERNAL = [
  'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  'M15 3h6v6',
  'M10 14L21 3'
];
const ICON_CLOSE = ['M6 6l12 12', 'M18 6L6 18'];

// Single icon builder for every glyph the script injects. Stroke-based inline SVG
// keeps one icon language across the page and renders identically on every
// platform, unlike emoji/dingbat characters which are font-dependent.
function buildIcon(paths, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function buildToastIcon(type) {
  const wrap = document.createElement('div');
  wrap.className = 'toast-icon';
  if (type === 'loading') {
    const sp = document.createElement('div');
    sp.className = 'spinner spinner--sm';
    sp.setAttribute('aria-hidden', 'true');
    wrap.appendChild(sp);
    return wrap;
  }
  wrap.appendChild(buildIcon(TOAST_ICONS[type] || TOAST_ICONS.info));
  return wrap;
}

let toastId = 0;
function toast(type, title, body = '', txHash = '') {
  const container = $('toastContainer');
  if (!container) return null;

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.dataset.toastId = String(++toastId);

  el.appendChild(buildToastIcon(type));

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'toast-body';

  const titleEl = document.createElement('strong');
  titleEl.textContent = title;
  bodyWrap.appendChild(titleEl);

  const bodyEl = document.createElement('p');
  bodyEl.textContent = body;
  bodyEl.hidden = !body;
  bodyWrap.appendChild(bodyEl);

  if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const link = document.createElement('a');
    link.className = 'toast-tx';
    link.href = `${EXPLORER}/tx/${txHash}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View on Explorer ';
    link.appendChild(buildIcon(ICON_EXTERNAL, 12));
    bodyWrap.appendChild(link);
  }
  el.appendChild(bodyWrap);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.appendChild(buildIcon(ICON_CLOSE, 14));
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  container.appendChild(el);

  let timer = null;
  const arm = t => {
    if (timer) clearTimeout(timer);
    const ms = t === 'error' ? 8000 : t === 'loading' ? 0 : 5000;
    if (ms > 0) timer = setTimeout(() => el.remove(), ms);
  };
  arm(type);

  return {
    el,
    update(nextType, nextTitle, nextBody = '') {
      el.className = `toast toast--${nextType}`;
      el.replaceChild(buildToastIcon(nextType), el.querySelector('.toast-icon'));
      titleEl.textContent = nextTitle;
      bodyEl.textContent = nextBody;
      bodyEl.hidden = !nextBody;
      arm(nextType);
    },
    dismiss() { if (timer) clearTimeout(timer); el.remove(); }
  };
}

// ── NFT Card rendering ─────────────────────────────────────────────────────────
function buildFallback() {
  const d = document.createElement('div');
  d.className = 'nft-artwork nft-artwork-fallback';
  d.textContent = 'Image unavailable';
  return d;
}

function buildNftCard(nft, staked = false) {
  const { tokenId, metadata, tier } = nft;
  const title = metadata?.name || `RobinPump Green Flock #${String(tokenId).padStart(4, '0')}`;
  // Demo cards point at artwork bundled with the site. toGateway deliberately
  // rejects relative paths, and demoImage is only ever set by the demo dataset,
  // so no externally supplied string can take this branch.
  const image = (DEMO_MODE && nft.demoImage) ? nft.demoImage : toGateway(metadata?.image);
  const tierCfg = tier ? TIER_CONFIG[tier] : null;

  const card = document.createElement('article');
  card.className = `nft-card${staked ? ' nft-card--staked' : ''}`;
  card.dataset.tokenId = tokenId;

  // Image
  const imgWrap = document.createElement('div');
  imgWrap.className = 'nft-img-wrap';
  if (staked) {
    const stakedBadge = document.createElement('div');
    stakedBadge.className = 'nft-staked-badge';
    stakedBadge.textContent = 'STAKED';
    imgWrap.appendChild(stakedBadge);
  }
  if (image) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'nft-artwork';
    img.addEventListener('error', () => img.replaceWith(buildFallback()), { once: true });
    imgWrap.appendChild(img);
  } else {
    imgWrap.appendChild(buildFallback());
  }
  card.appendChild(imgWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'nft-card-body';

  /*
   * Is this id's tier still missing on-chain? Only meaningful for unstaked ids
   * (a staked id proves its tier exists) and only when the gate was actually
   * read — an unread gate must not label a card as blocked.
   */
  const tierPending = !staked && isTierPending(tokenId);

  const tierBadge = document.createElement('span');
  tierBadge.className = `nft-tier-badge ${tierCfg ? tierCfg.cssClass : 'tier-unknown'}`;
  // "Tier unknown" reads as a UI gap; "Rarity pending" states the actual reason
  // the card cannot be staked, so holders can tell the two situations apart.
  tierBadge.textContent = tierPending ? 'Rarity pending' : (tierCfg ? tierCfg.label : 'Tier unknown');
  if (tierPending) {
    tierBadge.title = 'The on-chain rarity tier for this NFT has not been written yet.';
  }
  body.appendChild(tierBadge);

  const idLabel = document.createElement('p');
  idLabel.className = 'nft-token-id';
  idLabel.textContent = `#${String(tokenId).padStart(4, '0')}`;
  body.appendChild(idLabel);

  const nameEl = document.createElement('h3');
  nameEl.textContent = title;
  body.appendChild(nameEl);

  const rateEl = document.createElement('p');
  rateEl.className = 'nft-rate';
  if (tierPending) {
    rateEl.textContent = 'Rate: set once rarity is written on-chain';
  } else {
    rateEl.textContent = tierCfg
      ? `${tierCfg.ratePerDay.toLocaleString(undefined, { maximumFractionDigits: 6 })} $ROBINPUMP / day`
      : 'Rate: requires staking contract';
  }
  body.appendChild(rateEl);

  if (staked) {
    const stake = nft.stake;

    const pendingEl = document.createElement('div');
    pendingEl.className = 'nft-pending';
    const pendingLabel = document.createElement('span');
    pendingLabel.textContent = 'Earned so far';
    const pendingValue = document.createElement('strong');
    pendingValue.id = `pending-${tokenId}`;
    pendingValue.textContent = stake ? formatUnits(localPending(stake), TOKEN_DECIMALS, 6) : '—';
    pendingEl.append(pendingLabel, pendingValue);
    body.appendChild(pendingEl);

    if (stake) {
      // Two countdowns per card: the lock term and the 24h claim cooldown.
      const metaRow = document.createElement('div');
      metaRow.className = 'nft-meta-row';

      const lockSpan = document.createElement('span');
      lockSpan.id = `lockCountdown-${tokenId}`;
      lockSpan.className = 'nft-countdown';

      const claimSpan = document.createElement('span');
      claimSpan.id = `claimCountdown-${tokenId}`;
      claimSpan.className = 'nft-countdown';

      metaRow.append(lockSpan, claimSpan);
      body.appendChild(metaRow);

      const bar = document.createElement('div');
      bar.className = 'nft-lock-bar';
      bar.title = `Locked ${formatDuration(stake.lockDuration)} — unlocks ${formatTimestamp(stake.unlockAt)}`;
      const progress = document.createElement('span');
      progress.className = 'nft-lock-progress';
      progress.id = `lockBar-${tokenId}`;
      bar.appendChild(progress);
      body.appendChild(bar);
    }
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'nft-actions';

  if (!UI_STAKING_ENABLED) {
    const disabledBtn = document.createElement('button');
    disabledBtn.type = 'button';
    disabledBtn.className = 'btn btn-outline btn-sm';
    disabledBtn.disabled = true;
    disabledBtn.setAttribute('aria-disabled', 'true');
    disabledBtn.textContent = staked ? 'Unstake (soon)' : 'Stake (soon)';
    disabledBtn.title = 'Staking contract not yet deployed';
    actions.appendChild(disabledBtn);
  } else if (staked) {
    const claimBtn = document.createElement('button');
    claimBtn.type = 'button';
    claimBtn.className = 'btn btn-outline btn-sm';
    claimBtn.textContent = 'Claim';
    claimBtn.dataset.action = 'claim';
    claimBtn.dataset.tokenId = tokenId;

    const unstakeBtn = document.createElement('button');
    unstakeBtn.type = 'button';
    unstakeBtn.className = 'btn btn-primary btn-sm';
    unstakeBtn.textContent = 'Unstake';
    unstakeBtn.dataset.action = 'unstake';
    unstakeBtn.dataset.tokenId = tokenId;
    actions.append(claimBtn, unstakeBtn);
  } else if (tierPending) {
    /*
     * The chain says this id has no tier, so stake() would revert with
     * TierNotConfigured. Offering the button anyway would cost the holder a
     * successful approve() transaction — ensureApproval() runs first — for a
     * stake that cannot land. So the button is disabled before any gas is
     * spent, and the card says why.
     */
    const disabledBtn = document.createElement('button');
    disabledBtn.type = 'button';
    disabledBtn.className = 'btn btn-outline btn-sm';
    disabledBtn.disabled = true;
    disabledBtn.setAttribute('aria-disabled', 'true');
    disabledBtn.textContent = 'Rarity pending';
    disabledBtn.title = 'Staking unlocks for this NFT once its rarity tier is written on-chain. No gas is spent trying.';
    actions.appendChild(disabledBtn);

    const note = document.createElement('p');
    note.className = 'nft-pending-note';
    note.textContent = 'Rarity for this token ID has not been written on-chain yet, so staking would be rejected. Nothing is lost — check back after the rarity rollout.';
    body.appendChild(note);
  } else {
    const stakeBtn = document.createElement('button');
    stakeBtn.type = 'button';
    stakeBtn.className = 'btn btn-primary btn-sm';
    stakeBtn.textContent = 'Stake';
    stakeBtn.dataset.action = 'stake';
    stakeBtn.dataset.tokenId = tokenId;
    actions.appendChild(stakeBtn);
  }

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

// ── Live ticker ────────────────────────────────────────────────────────────────
// Repaints one staked card from its on-chain record plus locally elapsed time.
// Called on render and once per second; no RPC traffic.
function applyStakeCardState(tokenId, stake, now) {
  if (!stake) return;
  const card = document.querySelector(`.nft-card[data-token-id="${tokenId}"]`);
  if (!card) return;

  const unlockedNow = now >= stake.unlockAt;
  const claimableNow = now >= stake.nextClaimAt;

  const pendingEl = $(`pending-${tokenId}`);
  if (pendingEl) pendingEl.textContent = formatUnits(localPending(stake, now), TOKEN_DECIMALS, 6);

  const lockEl = $(`lockCountdown-${tokenId}`);
  if (lockEl) {
    lockEl.textContent = unlockedNow
      ? 'Unlocked'
      : `Unlocks in ${formatCountdown(stake.unlockAt - now)}`;
    lockEl.classList.toggle('nft-countdown--ready', unlockedNow);
    lockEl.classList.toggle('nft-countdown--locked', !unlockedNow);
  }

  const claimEl = $(`claimCountdown-${tokenId}`);
  if (claimEl) {
    claimEl.textContent = claimableNow
      ? 'Claim ready'
      : `Claim in ${formatCountdown(stake.nextClaimAt - now)}`;
    claimEl.classList.toggle('nft-countdown--ready', claimableNow);
  }

  const bar = $(`lockBar-${tokenId}`);
  if (bar) {
    const span = stake.unlockAt - stake.stakedAt;
    const done = span > 0 ? Math.min(100, Math.max(0, ((now - stake.stakedAt) / span) * 100)) : 100;
    bar.style.width = `${done.toFixed(2)}%`;
  }

  const claimBtn = card.querySelector('[data-action="claim"]');
  if (claimBtn) {
    claimBtn.disabled = !claimableNow;
    claimBtn.setAttribute('aria-disabled', String(!claimableNow));
    claimBtn.title = claimableNow
      ? 'Claim the rewards accrued so far'
      : `Claim cooldown — next claim ${formatTimestamp(stake.nextClaimAt)}`;
  }

  // Early exit is forbidden by the contract, so the button stays disabled for
  // the whole term rather than reverting on-chain.
  const unstakeBtn = card.querySelector('[data-action="unstake"]');
  if (unstakeBtn) {
    unstakeBtn.disabled = !unlockedNow;
    unstakeBtn.setAttribute('aria-disabled', String(!unlockedNow));
    unstakeBtn.title = unlockedNow
      ? 'Withdraw this NFT and claim any remaining rewards'
      : `Locked until ${formatTimestamp(stake.unlockAt)} — no early withdrawal`;
  }
}

/*
 * Caps an accrued figure at what the reward pool can actually pay.
 *
 * claim() settles against rewardToken.balanceOf(stakingContract) and reverts
 * with InsufficientRewardPool when it falls short, so anything above the pool
 * balance is accrued-but-unpayable, not claimable. A pool that has not been
 * read yet (null) is not treated as a limit.
 */
function payableNow(amount) {
  if (rewardPoolBalance === null) return amount;
  return amount > rewardPoolBalance ? rewardPoolBalance : amount;
}

// Renders the pool readout and returns whether the pool is short of `claimable`.
function renderRewardPool(claimable) {
  const known = rewardPoolBalance !== null;
  setText('rewardPoolValue', known
    ? `${formatUnits(rewardPoolBalance, TOKEN_DECIMALS, 2)} ROBINPUMP`
    : '—');

  const short = known && claimable > rewardPoolBalance;
  const el = $('rewardPoolNotice');
  if (el) {
    el.hidden = !short;
    el.textContent = short
      ? `The reward pool holds ${formatUnits(rewardPoolBalance, TOKEN_DECIMALS, 2)} ROBINPUMP, less than your accrued ${formatUnits(claimable, TOKEN_DECIMALS, 2)}. Claims are limited to the pool balance until it is topped up. Your accrual keeps running and nothing is lost.`
      : '';
  }
  return short;
}

// Renders the owedRewards credit + its withdraw control.
function renderOwedRewards() {
  const has = owedRewards > 0n;
  toggle('owedRewardsRow', has);
  setText('owedRewardsValue', `${formatUnits(owedRewards, TOKEN_DECIMALS, 4)} ROBINPUMP`);
  const btn = $('claimOwedBtn');
  if (btn) {
    btn.disabled = !has;
    btn.setAttribute('aria-disabled', String(!has));
  }
}

function tickLiveValues() {
  const now = chainNow();
  let total = 0n;
  let accruedClaimable = 0n;
  let unlockedCount = 0;
  let soonestClaim = 0;

  stakeIndex.forEach((stake, tokenId) => {
    const pending = localPending(stake, now);
    total += pending;
    if (now >= stake.nextClaimAt) accruedClaimable += pending;
    else if (!soonestClaim || stake.nextClaimAt < soonestClaim) soonestClaim = stake.nextClaimAt;
    if (now >= stake.unlockAt) unlockedCount++;
    applyStakeCardState(tokenId, stake, now);
  });

  // What the pool can actually pay right now — never advertise more than this.
  const claimable = payableNow(accruedClaimable);
  const poolShort = renderRewardPool(accruedClaimable);
  renderOwedRewards();

  const staked = stakeIndex.size;
  toggle('stakeSummary', staked > 0);

  if (staked) {
    setText('liveEarnedValue', formatUnits(total, TOKEN_DECIMALS, 6));
    setText('summaryRateValue', `${formatUnits(walletRatePerSecond * BigInt(DAY_SECONDS), TOKEN_DECIMALS, 2)} / day`);
    setText('summaryClaimableValue', formatUnits(claimable, TOKEN_DECIMALS, 4));
    setText('summaryNextClaimValue', claimable > 0n
      ? 'Ready now'
      : soonestClaim ? formatCountdown(soonestClaim - now) : '—');
    setText('summaryLockValue', `${unlockedCount} unlocked / ${staked - unlockedCount} locked`);
    setText('statPending', formatUnits(total, TOKEN_DECIMALS, 2));
  }

  const claimAllBtn = $('claimAllBtn');
  if (claimAllBtn) {
    const ready = claimable > 0n;
    claimAllBtn.disabled = !ready;
    claimAllBtn.setAttribute('aria-disabled', String(!ready));
  }
  setText('claimAllAmount', `${formatUnits(claimable, TOKEN_DECIMALS, 4)} ROBINPUMP`);
  setText('claimAllHint', poolShort
    ? 'Reward pool is being topped up — claims are capped at the pool balance. Your accrual continues.'
    : claimable > 0n
      ? 'Each NFT can be claimed once every 24 hours. NFTs still cooling down are skipped.'
      : soonestClaim
        ? `Next claim unlocks in ${formatCountdown(soonestClaim - now)}.`
        : 'Each NFT can be claimed once every 24 hours.');
}

function stopTicker() {
  if (tickerId) { clearInterval(tickerId); tickerId = null; }
}

function startTicker() {
  stopTicker();
  tickLiveValues();
  if (stakeIndex.size) tickerId = setInterval(tickLiveValues, 1000);
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function applyTabState() {
  const available = nftData.filter(n => !n.staked).length;
  const staked    = nftData.filter(n => n.staked).length;

  document.querySelectorAll('.tab-btn').forEach(b => {
    const isActive = b.dataset.tab === activeTab;
    b.classList.toggle('tab-btn--active', isActive);
    b.setAttribute('aria-selected', String(isActive));
    b.tabIndex = isActive ? 0 : -1;
  });

  toggle('panelAvailable', activeTab === 'available');
  toggle('panelStaked',    activeTab === 'staked');

  // Grid and empty state are mutually exclusive within each panel.
  toggle('nftGridAvailable', available > 0);
  toggle('emptyAvailable',   available === 0);
  toggle('nftGridStaked',    staked > 0);
  toggle('emptyStaked',      staked === 0);
}

function selectTab(tab) {
  if (tab !== 'available' && tab !== 'staked') return;
  activeTab = tab;
  applyTabState();
}

// ── Dashboard rendering ────────────────────────────────────────────────────────
function renderDashboard() {
  const available = nftData.filter(n => !n.staked);
  const staked    = nftData.filter(n => n.staked);

  setText('tabCountAvailable', available.length);
  setText('tabCountStaked', staked.length);

  const gridAvail = $('nftGridAvailable');
  if (gridAvail) {
    gridAvail.replaceChildren();
    available.forEach(n => gridAvail.appendChild(buildNftCard(n, false)));
  }

  const gridStaked = $('nftGridStaked');
  if (gridStaked) {
    gridStaked.replaceChildren();
    staked.forEach(n => gridStaked.appendChild(buildNftCard(n, true)));
  }

  // The tier table is display-only; rewardRateOf() is authoritative when read.
  const dailyTotal = staked.reduce((sum, n) => {
    const t = n.tier ? TIER_CONFIG[n.tier] : null;
    return sum + (t ? t.ratePerDay : 0);
  }, 0);

  setText('statYourNfts', nftData.length);
  setText('statStaked', staked.length);
  setText('statDaily', walletRatePerSecond > 0n
    ? `${formatUnits(walletRatePerSecond * BigInt(DAY_SECONDS), TOKEN_DECIMALS, 2)}/day`
    : staked.length
      ? `${dailyTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}/day`
      : '—');
  if (!staked.length) setText('statPending', '—');

  toggle('claimAllBar', staked.length > 0 && UI_STAKING_ENABLED);
  show('dashboardTabs');
  applyTabState();

  // Paint live values once, then keep them ticking every second.
  startTicker();
}

// ── Main refresh ───────────────────────────────────────────────────────────────
function setBusy(busy, message) {
  toggle('nftLoading', busy);
  if (message) setText('nftLoadingText', message);
  const btn = $('refreshBtn');
  if (btn) btn.disabled = busy;
}

function setStatus(message, tone = 'info') {
  const el = $('runtimeStatus');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
  el.classList.toggle('staking-runtime-status--warn', tone === 'warn');
}

async function refreshState() {
  // Demo mode re-renders from local state; it must not reach the RPC layer.
  if (DEMO_MODE) {
    buildDemoState();
    renderDemoBalance();
    renderDashboard();
    setDemoStatus();
    return;
  }
  if (!account || refreshLock) return;
  refreshLock = true;
  setStatus('');
  setBusy(true, 'Reading your NFTs from Robinhood Chain…');

  try {
    const chainId = await rpc('eth_chainId');
    updateDetectedNetwork(chainId);

    if (!isRobinhoodChain(chainId)) {
      setView('wrongNetwork');
      return;
    }
    setView('dashboard');

    // Reward token balance
    try {
      const balRaw = await call(CFG.rewardToken.address, `0x70a08231${encodeAddr(account)}`);
      setText('statBalance', formatUnits(decodeUint(balRaw), CFG.rewardToken.decimals, 2));
    } catch {
      setText('statBalance', '—');
    }

    // NFT balance + ownership index
    setBusy(true, 'Indexing Transfer events for your wallet…');
    const [nftBalRaw, tokenIds] = await Promise.all([
      call(CFG.greenFlockCollection.address, `0x70a08231${encodeAddr(account)}`),
      getOwnedTokenIds(account)
    ]);
    const nftBalance = decodeUint(nftBalRaw);

    // A mismatch means the log index lags the balance. Show what we have and
    // warn — never blank the whole dashboard over it.
    const indexLag = nftBalance !== BigInt(tokenIds.length);

    // Staked NFTs are held by the staking contract, so the Transfer replay above
    // can never see them — they come only from getStakedTokenIds(owner).
    let stakedRecords = new Map();
    if (STAKING_ACTIVE) {
      setBusy(true, 'Reading your staking positions…');
      try {
        ({ records: stakedRecords } = await readStakingState(account));
      } catch (err) {
        stakedRecords = new Map();
        walletRatePerSecond = 0n;
        setStatus(`Staking positions could not be read: ${friendlyError(err)}`, 'warn');
      }
    }
    stakeIndex = stakedRecords;

    const walletIds = new Set(tokenIds);
    const allIds = [...tokenIds, ...[...stakedRecords.keys()].filter(id => !walletIds.has(id))];

    /*
     * Ask the chain which of the wallet's unstaked ids still have no tier. Free
     * (a view), and it must happen before any card renders a Stake button:
     * clicking Stake runs ensureApproval() first, and that approve costs real
     * gas even though the stake that follows would revert with
     * TierNotConfigured. Staked ids are skipped — being staked proves the tier
     * was written.
     */
    unconfiguredIds = await readTierGate(tokenIds.filter(id => !stakedRecords.has(id)));

    setBusy(true, `Loading metadata for ${allIds.length} NFT${allIds.length !== 1 ? 's' : ''}…`);
    nftData = await Promise.all(
      allIds.map(async tokenId => {
        const metadata = await fetchMetadata(tokenId);
        const stake = stakedRecords.get(tokenId) || null;
        return { tokenId, metadata, tier: getTierFromMetadata(metadata), staked: !!stake, stake };
      })
    );

    // Collection name
    try {
      const nameRaw = await call(CFG.greenFlockCollection.address, '0x06fdde03');
      setText('collectionName', decodeString(nameRaw) || 'Green Flock');
      setText('collectionStatus', 'ERC-721 verified');
    } catch {
      setText('collectionStatus', 'Unverified');
    }

    renderDashboard();

    if (indexLag) {
      setStatus(`Showing ${tokenIds.length} of ${nftBalance.toString()} NFTs — the Transfer index is still catching up. Hit Refresh in a moment.`, 'warn');
    } else if (!tokenIds.length) {
      setStatus('No Green Flock NFTs found in this wallet.');
    } else if (!STAKING_ACTIVE) {
      setStatus(`${tokenIds.length} Green Flock NFT${tokenIds.length !== 1 ? 's' : ''} found. Staking opens once the on-chain rarity tiers and the $ROBINPUMP reward vault are in place.`);
    } else {
      setStatus('');
    }
  } catch (err) {
    setView('dashboard');
    setStatus(friendlyError(err), 'warn');
  } finally {
    setBusy(false);
    refreshLock = false;
  }
}

// ── Wallet connection ──────────────────────────────────────────────────────────
async function connectWallet(btn) {
  if (DEMO_MODE) {
    toast('info', 'Preview mode.', 'Wallet actions are disabled here. Open staking.html without ?demo=1 to use the live page.');
    return;
  }
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  try {
    // Accounts first: several wallets reject chain switching from an
    // origin they have not authorised yet.
    const accounts = await rpc('eth_requestAccounts');
    account = accounts?.[0] || null;
    if (!account) throw new Error('No account selected in wallet.');
    renderWalletChip();

    try {
      await ensureRobinhoodChain();
    } catch (switchErr) {
      updateDetectedNetwork(await rpc('eth_chainId').catch(() => detectedChainId));
      setView('wrongNetwork');
      toast('error', 'Network switch failed.', friendlyError(switchErr));
      return;
    }
    await refreshState();
  } catch (err) {
    if (err.code === 4001) {
      toast('error', 'Wallet connection rejected.', 'You declined the connection request in your wallet.');
    } else {
      toast('error', 'Connection failed.', friendlyError(err));
    }
  } finally {
    if (btn) { btn.disabled = false; if (!account && label) btn.textContent = 'Connect Wallet'; }
    renderWalletChip();
  }
}

function disconnectWallet() {
  if (DEMO_MODE) {
    toast('info', 'Preview mode.', 'There is no wallet connected — this session is synthetic.');
    return;
  }
  resetState();
  toast('info', 'Wallet disconnected.', 'RobinPump cleared this browser session. Your wallet stays under your control.');
}

function resetState() {
  account = null;
  nftData = [];
  stopTicker();
  stakeIndex = new Map();
  walletRatePerSecond = 0n;
  // Back to "not read yet" — not 0n, which would render as an empty pool.
  rewardPoolBalance = null;
  owedRewards = 0n;
  // Same reasoning: null is "never asked", not "every id is configured". The
  // next wallet must not inherit this wallet's rarity gate.
  unconfiguredIds = null;
  hide('stakeSummary');
  hide('owedRewardsRow');
  hide('rewardPoolNotice');
  setView('connect');
  renderWalletChip();
  ['statYourNfts', 'statStaked', 'statDaily', 'statPending', 'statBalance'].forEach(id => setText(id, '—'));
  hide('dashboardTabs');
  hide('claimAllBar');
  setStatus('');
  setBusy(false);
}

// ── Error messages ─────────────────────────────────────────────────────────────
/*
 * Custom-error decoding.
 *
 * The contract reverts with custom errors, which reach the browser as 4-byte
 * selectors buried in provider-specific error shapes. Matching on the selector
 * is the only reliable route: the surrounding message text differs per wallet.
 * Selectors are derived at runtime from the canonical signatures, so they
 * cannot drift from the deployed ABI the way hard-coded hex would.
 */
const REVERT_MESSAGES = Object.freeze([
  ['InsufficientRewardPool(uint256,uint256)',
   'The reward pool is short right now. Nothing is lost — your rewards keep accruing on-chain. Claim again once the pool is topped up, or claim a single NFT instead of all of them.'],
  ['TierNotConfigured(uint256)',
   'This NFT has no rarity tier set on-chain yet, so it cannot be staked. Rarity configuration is still in progress.'],
  ['RewardRateNotSet(uint8)',
   'The reward rate for this rarity tier is not set on-chain yet.'],
  ['StakeLocked(uint256,uint256)',
   'This NFT is still inside its lock period. There is no early withdrawal — wait for the unlock time.'],
  ['ClaimCooldownActive(uint256,uint256)',
   'This NFT was already claimed within the last 24 hours. Wait for the cooldown to finish.'],
  ['NothingOwed()',
   'There is no deferred reward credit on this address to withdraw.'],
  ['AlreadyStaked(uint256)',      'This NFT is already staked.'],
  ['NotStaked(uint256)',          'This NFT is not staked.'],
  ['NotStaker(uint256,address)',  'This NFT was staked by a different address.'],
  ['NotTokenOwner(uint256,address)', 'Your wallet does not own this NFT.'],
  ['InvalidLockDuration(uint256,uint256,uint256)',
   'That lock duration is outside the allowed 7-day to 1095-day window.'],
  ['BatchTooLarge(uint256,uint256)',
   'Too many NFTs in one transaction — the contract caps a batch at 50.'],
  ['RarityAlreadyLocked()',       'The rarity mapping is permanently locked and cannot be changed.'],
  ['DirectNftTransferNotAllowed()',
   'NFTs cannot be sent to the staking contract directly — use the Stake button.']
].map(([signature, message]) => [selector(signature), message]));

// Pulls the revert selector out of whatever shape the provider produced.
function revertSelectorOf(err) {
  const data = err?.data?.originalError?.data ?? err?.data?.data ?? err?.data ?? err?.error?.data;
  const hex = typeof data === 'string' ? data : '';
  if (/^0x[0-9a-fA-F]{8}/.test(hex)) return hex.slice(0, 10).toLowerCase();
  // Fallback: some wallets only embed the revert payload inside the message.
  const found = String(err?.message || '').match(/0x[0-9a-fA-F]{8,}/);
  return found ? found[0].slice(0, 10).toLowerCase() : null;
}

function friendlyError(err) {
  if (!err) return 'Unknown error.';
  const msg = err?.message || String(err);
  if (err.code === 4001 || msg.includes('rejected') || msg.includes('denied')) return 'Transaction rejected in your wallet.';
  if (msg.includes('insufficient funds')) return 'Insufficient ETH for gas fees.';
  if (msg.includes('nonce')) return 'Nonce mismatch — reset your wallet pending transactions.';
  if (msg.includes('No EVM wallet')) return msg;

  const sel = revertSelectorOf(err);
  if (sel) {
    const hit = REVERT_MESSAGES.find(([s]) => s === sel);
    if (hit) return hit[1];
  }

  if (msg.length > 160) return `${msg.slice(0, 160)}…`;
  return msg;
}

// ── Staking actions (disabled until contract deployed) ─────────────────────────
function requireStakingActive() {
  if (STAKING_ACTIVE) return true;
  // The contract itself is deployed; what is still missing is the on-chain rarity
  // table and the reward vault balance. Saying "not deployed" here would be wrong.
  toast('info', 'Staking is not live yet.', 'Rarity tiers are not written on-chain yet and the reward vault is unfunded. Wallet discovery works in the meantime.');
  return false;
}

// ── Transaction plumbing ───────────────────────────────────────────────────────
function txExplorerUrl(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

async function sendTx(to, data) {
  // Hard barrier between the preview and the real transaction path. Reaching
  // this line with DEMO_MODE on means a demo branch leaked into the live layer;
  // throwing is preferable to prompting for a signature.
  if (DEMO_MODE) {
    throw new Error('Preview mode is active — no transaction can be signed.');
  }
  // Re-verify the chain at send time: the user may have switched networks
  // between the last read and this click.
  const chainId = await rpc('eth_chainId');
  if (!isRobinhoodChain(chainId)) {
    throw new Error(`Wrong network — switch to ${CFG.network.label} before signing.`);
  }
  return rpc('eth_sendTransaction', [{ from: account, to, data }]);
}

// Polls until the transaction is mined. Resolves with the receipt, or throws
// when the transaction reverted or polling exceeded the timeout.
async function waitForReceipt(hash, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) {
      if (decodeUint(receipt.status) !== 1n) throw new Error('Transaction reverted on-chain.');
      return receipt;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for confirmation. Check the explorer for the final status.');
}

// Serialises wallet interactions and funnels progress into a single toast.
async function runTx({ label, buildData, to, pendingText, successTitle, successBody }) {
  if (!requireStakingActive()) return false;
  if (txPending) {
    toast('info', 'One transaction at a time.', 'Wait for the pending transaction to confirm.');
    return false;
  }
  txPending = true;
  const t = toast('info', label, 'Confirm in your wallet…');
  try {
    const data = await buildData();
    if (data === null) { t.dismiss(); return false; }

    const hash = await sendTx(to, data);
    t.update('info', pendingText || 'Transaction submitted.', 'Waiting for confirmation…');
    await waitForReceipt(hash);
    t.dismiss();
    toast('success', successTitle, successBody, hash);
    await refreshState();
    return true;
  } catch (err) {
    t.dismiss();
    toast('error', `${label} failed.`, friendlyError(err));
    return false;
  } finally {
    txPending = false;
  }
}

// ── Approval ───────────────────────────────────────────────────────────────────
// Per-token approve() is used rather than setApprovalForAll so the staking
// contract never holds blanket authority over the whole wallet.
async function ensureApproval(tokenId) {
  const nft = CFG.greenFlockCollection.address;
  const staking = CFG.stakingContract.toLowerCase();

  const operatorRaw = await call(nft, `${SEL.isApprovedForAll}${encodeAddr(account)}${encodeAddr(CFG.stakingContract)}`)
    .catch(() => null);
  if (operatorRaw && decodeUintAt(operatorRaw, 0) === 1n) return;

  const approvedRaw = await call(nft, `${SEL.getApproved}${encodeUint(tokenId)}`).catch(() => null);
  if (approvedRaw && decodeAddressAt(approvedRaw, 0) === staking) return;

  const t = toast('info', 'Approval required.', `Approve the staking contract for #${tokenId}…`);
  try {
    const hash = await sendTx(nft, `${SEL.approve}${encodeAddr(CFG.stakingContract)}${encodeUint(tokenId)}`);
    t.update('info', 'Approval submitted.', 'Waiting for confirmation…');
    await waitForReceipt(hash);
    t.dismiss();
  } catch (err) {
    t.dismiss();
    throw err;
  }
}

// ── Actions ────────────────────────────────────────────────────────────────────
function handleStake(tokenId) {
  if (!DEMO_MODE && !requireStakingActive()) return;
  /*
   * Defence in depth. buildNftCard already renders a disabled button for ids
   * with no tier, but a card rendered before the gate was read stays on screen
   * until the next refresh. Stopping here keeps ensureApproval() — and its real
   * approve() gas — out of reach for a stake the contract would reject.
   */
  if (!DEMO_MODE && isTierPending(tokenId)) {
    toast('info', 'Rarity not written yet.',
      `#${tokenId} has no on-chain rarity tier, so staking would be rejected. No gas was spent.`);
    return;
  }
  openLockModal(tokenId);
}

async function confirmStake(tokenId, days) {
  const seconds = days * DAY_SECONDS;
  if (seconds < lockLimits.min || seconds > lockLimits.max) {
    toast('error', 'Invalid lock duration.',
      `Pick between ${formatDuration(lockLimits.min)} and ${formatDuration(lockLimits.max)}.`);
    return;
  }
  if (DEMO_MODE) { await demoStake(tokenId, days); return; }
  await runTx({
    label: 'Stake',
    to: CFG.stakingContract,
    pendingText: 'Stake submitted.',
    successTitle: 'NFT staked.',
    successBody: `#${tokenId} is locked for ${formatDuration(seconds)}. Rewards accrue every second.`,
    buildData: async () => {
      // Approval is a separate transaction, so it runs before the stake call.
      await ensureApproval(tokenId);
      return `${SEL.stake}${encodeUint(tokenId)}${encodeUint(seconds)}`;
    }
  });
}

async function handleUnstake(tokenId) {
  const stake = stakeIndex.get(String(tokenId));
  if (stake && !isUnlocked(stake)) {
    toast('info', 'Still locked.',
      `#${tokenId} unlocks ${formatTimestamp(stake.unlockAt)}. Early withdrawal is not possible.`);
    return;
  }
  if (DEMO_MODE) { await demoUnstake(tokenId); return; }
  await runTx({
    label: 'Unstake',
    to: CFG.stakingContract,
    pendingText: 'Unstake submitted.',
    successTitle: 'NFT unstaked.',
    successBody: `#${tokenId} is back in your wallet along with any remaining rewards.`,
    buildData: async () => `${SEL.unstake}${encodeUint(tokenId)}`
  });
}

/*
 * Pre-flight against the reward pool.
 *
 * claim()/claimBatch() revert with InsufficientRewardPool when the settled
 * amount exceeds the pool, so a doomed claim is stopped here rather than
 * costing the user gas on a guaranteed revert. Only a shortfall the chain
 * actually reported blocks the click — an unread pool (null) never does.
 */
function poolCanCover(amount, { label = 'claim' } = {}) {
  if (DEMO_MODE || rewardPoolBalance === null) return true;
  if (amount <= rewardPoolBalance) return true;
  toast('info', 'Reward pool is being topped up.',
    rewardPoolBalance === 0n
      ? `The pool is empty, so this ${label} would fail on-chain. Your rewards keep accruing — nothing is lost.`
      : `The pool holds ${formatUnits(rewardPoolBalance, TOKEN_DECIMALS, 2)} ROBINPUMP, less than the ${formatUnits(amount, TOKEN_DECIMALS, 2)} this ${label} would settle. Try a single NFT, or wait for the next top-up.`);
  return false;
}

async function handleClaim(tokenId) {
  const stake = stakeIndex.get(String(tokenId));
  if (stake && !isClaimable(stake)) {
    toast('info', 'Claim cooling down.',
      `#${tokenId} can be claimed again ${formatTimestamp(stake.nextClaimAt)} (once every 24 hours).`);
    return;
  }
  if (stake && !poolCanCover(localPending(stake))) return;
  if (DEMO_MODE) { await demoClaim(tokenId); return; }
  await runTx({
    label: 'Claim',
    to: CFG.stakingContract,
    pendingText: 'Claim submitted.',
    successTitle: 'Rewards claimed.',
    successBody: `$ROBINPUMP from #${tokenId} was sent to your wallet.`,
    buildData: async () => `${SEL.claim}${encodeUint(tokenId)}`
  });
}

async function handleClaimAll() {
  const now = chainNow();
  // claimBatch() reverts the whole call if any id is still cooling down, so the
  // list is filtered here rather than letting the contract reject it. The cap
  // mirrors MAX_BATCH_SIZE; anything above it needs a second transaction.
  const ready = [...stakeIndex.entries()]
    .filter(([, s]) => now >= s.nextClaimAt)
    .map(([id]) => id);
  if (!ready.length) {
    toast('info', 'Nothing claimable yet.', 'Every staked NFT is still inside its 24-hour cooldown.');
    return;
  }
  if (DEMO_MODE) { await demoClaimAll(); return; }

  const batch = ready.slice(0, MAX_BATCH_SIZE);
  const remaining = ready.length - batch.length;
  // claimBatch() settles every id in one transaction, so the pool must cover
  // the whole batch or the entire call reverts.
  const batchTotal = batch.reduce((sum, id) => sum + localPending(stakeIndex.get(id), now), 0n);
  if (!poolCanCover(batchTotal, { label: 'claim-all' })) return;
  await runTx({
    label: 'Claim all',
    to: CFG.stakingContract,
    pendingText: 'Claim-all submitted.',
    successTitle: 'Rewards claimed.',
    successBody: `Claimed ${batch.length} NFT${batch.length !== 1 ? 's' : ''}.`
      + (remaining ? ` ${remaining} more are ready — run Claim all again.` : '')
      + ' NFTs still cooling down were skipped.',
    buildData: async () => `${SEL.claimBatch}${encodeUintArray(batch)}`
  });
}

/*
 * Withdraws the deferred-reward credit.
 *
 * unstake() always returns the NFT, but when the pool was short at settlement
 * time it books the reward as owedRewards[staker] instead of transferring it.
 * claimOwed() is the only way to collect that credit, so it must be reachable
 * from the UI or the balance is stranded on-chain.
 */
async function handleClaimOwed() {
  if (DEMO_MODE) {
    toast('info', 'Preview mode.', 'Deferred rewards are not simulated in the preview.');
    return;
  }
  if (owedRewards === 0n) {
    toast('info', 'Nothing owed.', 'This address has no deferred reward credit to withdraw.');
    return;
  }
  if (!poolCanCover(owedRewards, { label: 'withdrawal' })) return;
  await runTx({
    label: 'Withdraw owed rewards',
    to: CFG.stakingContract,
    pendingText: 'Withdrawal submitted.',
    successTitle: 'Deferred rewards withdrawn.',
    successBody: `${formatUnits(owedRewards, TOKEN_DECIMALS, 4)} ROBINPUMP was sent to your wallet.`,
    buildData: async () => SEL.claimOwed
  });
}

// ── Lock duration picker ───────────────────────────────────────────────────────
// Not staked yet, so there is no on-chain record to read — estimate from the
// display tier table instead.
function estimateLockReward(tokenId, days) {
  const nft = nftData.find(n => String(n.tokenId) === String(tokenId));
  const tierCfg = nft?.tier ? TIER_CONFIG[nft.tier] : null;
  if (!tierCfg) return null;
  return tierCfg.ratePerDay * days;
}

function renderLockPreview() {
  const seconds = lockDays * DAY_SECONDS;
  const now = chainNow();

  setText('lockDaysOutput', formatDuration(seconds));
  setText('lockUnlockDate', formatTimestamp(now + seconds));
  setText('lockFirstClaim', `${formatTimestamp(now + lockLimits.cooldown)} (24h after staking)`);

  const estimate = estimateLockReward(lockModalTokenId, lockDays);
  setText('lockRewardEstimate', estimate === null
    ? 'Tier unknown — rate set on-chain'
    : `≈ ${estimate.toLocaleString(undefined, { maximumFractionDigits: 2 })} $ROBINPUMP`);

  document.querySelectorAll('.lock-preset').forEach(btn => {
    const active = Number(btn.dataset.lockDays) === lockDays;
    btn.classList.toggle('lock-preset--active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const range = $('lockRange');
  if (range) {
    range.value = String(lockDays);
    // Paint the filled portion of the track.
    const pct = ((lockDays - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
    range.style.background =
      `linear-gradient(90deg, var(--green) ${pct.toFixed(2)}%, rgba(255,255,255,.08) ${pct.toFixed(2)}%)`;
  }
}

function setLockDays(days) {
  const minDays = Math.ceil(lockLimits.min / DAY_SECONDS);
  const maxDays = Math.floor(lockLimits.max / DAY_SECONDS);
  lockDays = Math.min(maxDays, Math.max(minDays, Math.round(Number(days) || minDays)));
  renderLockPreview();
}

function openLockModal(tokenId) {
  lockModalTokenId = String(tokenId);
  lockReturnFocus = document.activeElement;

  setText('lockModalToken', `#${String(tokenId).padStart(4, '0')}`);
  setText('lockModalSub',
    `Pick how long #${tokenId} stays locked. Minimum ${formatDuration(lockLimits.min)}, maximum ${formatDuration(lockLimits.max)}. ` +
    `Rewards accrue every second and can be claimed once every ${formatDuration(lockLimits.cooldown)}.`);

  const range = $('lockRange');
  if (range) {
    range.min = String(Math.ceil(lockLimits.min / DAY_SECONDS));
    range.max = String(Math.floor(lockLimits.max / DAY_SECONDS));
  }
  setLockDays(Math.ceil(lockLimits.min / DAY_SECONDS));

  show('lockModal');
  $('lockConfirmBtn')?.focus();
}

function closeLockModal() {
  hide('lockModal');
  lockModalTokenId = null;
  if (lockReturnFocus instanceof HTMLElement) lockReturnFocus.focus();
  lockReturnFocus = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO / PREVIEW MODE
// ═══════════════════════════════════════════════════════════════════════════════
// Everything below runs only when DEMO_MODE is true (staking.html?demo=1).
// It is fully self-contained: no function here calls rpc(), call(), sendTx() or
// any other chain primitive, and sendTx() throws outright if DEMO_MODE is on.
// The real transaction path is never modified — the handlers simply return early
// into these simulations before reaching runTx().

// Obviously fake but hex-valid, so nothing downstream chokes on it.
const DEMO_ACCOUNT = '0xdEaD00000000000000000000000000000000beef';

const DEMO_INVENTORY = [
  { tokenId: '7',    tier: 'LEGENDARY', image: 'nft%20image/1.jpg'  },
  { tokenId: '142',  tier: 'EPIC',      image: 'nft%20image/5.jpg'  },
  { tokenId: '888',  tier: 'RARE',      image: 'nft%20image/9.jpg'  },
  { tokenId: '1337', tier: 'UNCOMMON',  image: 'nft%20image/14.jpg' },
  { tokenId: '2024', tier: 'COMMON',    image: 'nft%20image/21.jpg' }
];

// Covers every card state the staked tab can render: locked + claim ready,
// unlocked + cooling down, long lock + claim ready.
const DEMO_STAKED_SEED = [
  { tokenId: '7',   lockDays: 365,  stakedDaysAgo: 200, lastClaimHoursAgo: 30 },
  { tokenId: '142', lockDays: 7,    stakedDaysAgo: 8,   lastClaimHoursAgo: 2  },
  { tokenId: '888', lockDays: 1095, stakedDaysAgo: 10,  lastClaimHoursAgo: 25 }
];

// Mutable demo session: which tokens are staked, and the simulated wallet balance.
let demoRecords = new Map();   // tokenId → same shape decodeStakeInfo() returns
let demoBalance = 0n;
let demoSeeded = false;

const demoDelay = ms => new Promise(r => setTimeout(r, ms));

function demoRatePerDay(tier) {
  const cfg = TIER_CONFIG[tier];
  return cfg ? toBaseUnits(cfg.ratePerDay) : 0n;
}

function demoMetadata(entry) {
  return {
    name: `RobinPump Green Flock #${String(entry.tokenId).padStart(4, '0')}`,
    attributes: [{ trait_type: 'Tier', value: entry.tier }]
  };
}

// Builds a record with exactly the field types decodeStakeInfo() produces:
// BigInt for token amounts and the daily rate, Number for every timestamp. A
// mismatch here would make localPending() throw on mixed-type arithmetic in the
// 1s ticker.
function demoRecord(tier, { stakedAt, lockDuration, lastClaimAt }) {
  const tierIndex = Object.keys(TIER_CONFIG).indexOf(tier);
  return {
    owner:        DEMO_ACCOUNT.toLowerCase(),
    tier:         tierIndex < 0 ? 0 : tierIndex,
    stakedAt,
    lastClaimAt,
    lockDuration,
    unlockAt:     stakedAt + lockDuration,
    nextClaimAt:  lastClaimAt + lockLimits.cooldown,
    pending:      0n,
    ratePerDay:   demoRatePerDay(tier)
  };
}

function seedDemoRecords() {
  const now = chainNow();
  demoRecords = new Map();
  DEMO_STAKED_SEED.forEach(seed => {
    const entry = DEMO_INVENTORY.find(e => e.tokenId === seed.tokenId);
    if (!entry) return;
    demoRecords.set(seed.tokenId, demoRecord(entry.tier, {
      stakedAt:     now - seed.stakedDaysAgo * DAY_SECONDS,
      lockDuration: seed.lockDays * DAY_SECONDS,
      lastClaimAt:  now - seed.lastClaimHoursAgo * 3600
    }));
  });
  demoBalance = toBaseUnits('12500.5');
  demoSeeded = true;
}

// Projects the mutable demo session into the same nftData / stakeIndex shapes the
// live path produces, so every renderer downstream is untouched by demo mode.
function buildDemoState() {
  if (!demoSeeded) seedDemoRecords();

  stakeIndex = new Map(demoRecords);
  walletRatePerSecond = [...demoRecords.values()]
    .reduce((sum, r) => sum + r.ratePerDay / BigInt(DAY_SECONDS), 0n);

  nftData = DEMO_INVENTORY.map(entry => {
    const stake = demoRecords.get(entry.tokenId) || null;
    return {
      tokenId:   entry.tokenId,
      metadata:  demoMetadata(entry),
      tier:      entry.tier,
      staked:    !!stake,
      stake,
      demoImage: entry.image
    };
  });
}

function renderDemoBalance() {
  setText('statBalance', formatUnits(demoBalance, TOKEN_DECIMALS, 2));
}

function setDemoStatus() {
  setStatus('Preview mode — 5 synthetic NFTs, no wallet and no chain reads. Every action below is simulated locally.', 'warn');
}

function startDemoSession() {
  account = DEMO_ACCOUNT;
  detectedChainId = `0x${Number(CFG.network.chainId).toString(16)}`;
  chainClock = { chainNow: Math.floor(Date.now() / 1000), readAt: Date.now() };

  seedDemoRecords();
  renderWalletChip();
  // Overwrite the chip label so the fake address can't read as a live connection.
  setText('walletNetworkLabel', 'Preview (no wallet)');
  setView('dashboard');
  setText('collectionName', 'Green Flock (preview)');
  setText('collectionStatus', 'Synthetic data');

  buildDemoState();
  renderDemoBalance();
  renderDashboard();
  setDemoStatus();
}

// Mirrors runTx()'s toast choreography and single-flight lock so the preview
// feels identical, but resolves from local state instead of a wallet.
async function runDemoTx({ label, pendingText, successTitle, successBody, apply }) {
  if (txPending) {
    toast('info', 'One transaction at a time.', 'Wait for the pending transaction to confirm.');
    return false;
  }
  txPending = true;
  const t = toast('info', label, 'Simulating — no wallet signature required…');
  try {
    await demoDelay(600);
    t.update('info', pendingText || 'Transaction submitted.', 'Waiting for confirmation…');
    await demoDelay(900);
    apply();
    buildDemoState();
    renderDemoBalance();
    renderDashboard();
    setDemoStatus();
    t.dismiss();
    toast('success', successTitle, successBody);
    return true;
  } catch (err) {
    t.dismiss();
    toast('error', `${label} failed.`, friendlyError(err));
    return false;
  } finally {
    txPending = false;
  }
}

async function demoStake(tokenId, days) {
  const id = String(tokenId);
  const entry = DEMO_INVENTORY.find(e => e.tokenId === id);
  if (!entry) return;
  const seconds = days * DAY_SECONDS;

  await runDemoTx({
    label: 'Stake (preview)',
    pendingText: 'Stake simulated.',
    successTitle: 'NFT staked in preview.',
    successBody: `#${id} is locked for ${formatDuration(seconds)}. Rewards tick every second — nothing was sent on-chain.`,
    apply: () => {
      const now = chainNow();
      demoRecords.set(id, demoRecord(entry.tier, {
        stakedAt:     now,
        lockDuration: seconds,
        lastClaimAt:  now
      }));
    }
  });
}

async function demoUnstake(tokenId) {
  const id = String(tokenId);
  await runDemoTx({
    label: 'Unstake (preview)',
    pendingText: 'Unstake simulated.',
    successTitle: 'NFT unstaked in preview.',
    successBody: `#${id} moved back to the available tab with its rewards credited to the simulated balance.`,
    apply: () => {
      const record = demoRecords.get(id);
      if (record) demoBalance += localPending(record);
      demoRecords.delete(id);
    }
  });
}

// Resets accrual exactly as _settle() does: pay out, advance lastClaimAt to the
// current instant, and restart the 24h cooldown from that same instant.
function applyDemoClaim(id, now) {
  const record = demoRecords.get(id);
  if (!record) return 0n;
  const paid = localPending(record, now);
  demoBalance += paid;
  demoRecords.set(id, {
    ...record,
    pending:     0n,
    lastClaimAt: now,
    nextClaimAt: now + lockLimits.cooldown
  });
  return paid;
}

async function demoClaim(tokenId) {
  const id = String(tokenId);
  let paid = 0n;
  await runDemoTx({
    label: 'Claim (preview)',
    pendingText: 'Claim simulated.',
    successTitle: 'Rewards claimed in preview.',
    successBody: `#${id} paid out to the simulated balance. The 24-hour cooldown restarts now.`,
    apply: () => { paid = applyDemoClaim(id, chainNow()); }
  });
  return paid;
}

async function demoClaimAll() {
  const now = chainNow();
  const ready = [...demoRecords.entries()].filter(([, r]) => now >= r.nextClaimAt).map(([id]) => id);
  await runDemoTx({
    label: 'Claim all (preview)',
    pendingText: 'Claim-all simulated.',
    successTitle: 'Rewards claimed in preview.',
    successBody: `Claimed ${ready.length} NFT${ready.length !== 1 ? 's' : ''}. NFTs still cooling down were skipped.`,
    apply: () => { ready.forEach(id => applyDemoClaim(id, chainNow())); }
  });
}

// ── Supply display ─────────────────────────────────────────────────────────────
// Demo mode must not emit a single RPC call, so the static figure is used.
if (DEMO_MODE) {
  setText('rewardSupply', '1,000,000,000');
} else {
  (async () => {
    try {
      const supplyRaw = await call(CFG.rewardToken.address, '0x18160ddd');
      setText('rewardSupply', formatUnits(decodeUint(supplyRaw), CFG.rewardToken.decimals, 0));
    } catch {
      setText('rewardSupply', '1,000,000,000');
    }
  })();
}

// ── Event delegation ───────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (!account) {
    toast('info', 'Connect your wallet first.', 'Use the Connect Wallet control in the header.');
    return;
  }
  const { action, tokenId } = btn.dataset;
  if (action === 'stake')   handleStake(tokenId);
  if (action === 'unstake') handleUnstake(tokenId);
  if (action === 'claim')   handleClaim(tokenId);
});

// Tabs — click plus arrow-key roving focus
const tabButtons = [...document.querySelectorAll('.tab-btn')];
tabButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  btn.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabButtons[(i + (e.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    selectTab(next.dataset.tab);
    next.focus();
  });
});

// Connect / disconnect
$('connectWalletNav')?.addEventListener('click', () => {
  if (account) disconnectWallet();
  else connectWallet($('connectWalletNav'));
});

// Copy connected address from the header chip
$('walletCopyBtn')?.addEventListener('click', async () => {
  if (!account) return;
  try {
    await navigator.clipboard.writeText(account);
    toast('success', 'Address copied.', account);
  } catch {
    toast('error', 'Copy unavailable.', 'Your browser blocked clipboard access.');
  }
});

$('switchNetworkBtn')?.addEventListener('click', async () => {
  try { await ensureRobinhoodChain(); await refreshState(); }
  catch (err) { toast('error', 'Network switch failed.', friendlyError(err)); }
});

$('refreshBtn')?.addEventListener('click', () => refreshState());

$('claimAllBtn')?.addEventListener('click', () => handleClaimAll());

$('claimOwedBtn')?.addEventListener('click', () => handleClaimOwed());

// ── Lock modal controls ────────────────────────────────────────────────────────
$('lockPresets')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-lock-days]');
  if (btn) setLockDays(btn.dataset.lockDays);
});

$('lockRange')?.addEventListener('input', e => setLockDays(e.target.value));

['lockCancelBtn', 'lockDismissBtn'].forEach(id =>
  $(id)?.addEventListener('click', () => closeLockModal()));

$('lockModal')?.addEventListener('click', e => {
  if (e.target.dataset.lockDismiss === 'true') closeLockModal();
});

$('lockConfirmBtn')?.addEventListener('click', () => {
  const tokenId = lockModalTokenId;
  const days = lockDays;
  if (!tokenId) return;
  closeLockModal();
  confirmStake(tokenId, days);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('lockModal')?.hidden) closeLockModal();
});

// Copy buttons in the contract cards
document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1800);
    } catch { btn.textContent = 'Copy unavailable'; }
  });
});

// Mobile nav (staking.html does not load script.js)
const hamburger = $('hamburger');
const navLinks = $('navLinks');
hamburger?.addEventListener('click', () => {
  const isOpen = navLinks?.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', String(!!isOpen));
  hamburger.classList.toggle('hamburger--open', !!isOpen);
});
navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
  navLinks.classList.remove('open');
  hamburger?.setAttribute('aria-expanded', 'false');
  hamburger?.classList.remove('hamburger--open');
}));

// ── Wallet events + passive reconnect ──────────────────────────────────────────
// In demo mode the wallet is never touched — no listeners are registered, so a
// real account or chain event cannot overwrite the synthetic session.
if (DEMO_MODE) {
  startDemoSession();
} else if (window.ethereum) {
  window.ethereum.on('accountsChanged', accs => {
    account = accs?.[0] || null;
    renderWalletChip();
    if (account) refreshState();
    else resetState();
  });
  window.ethereum.on('chainChanged', chainId => {
    updateDetectedNetwork(chainId);
    if (account) refreshState();
  });

  (async () => {
    try {
      const [accounts, chainId] = await Promise.all([rpc('eth_accounts'), rpc('eth_chainId')]);
      updateDetectedNetwork(chainId);
      account = accounts?.[0] || null;
      renderWalletChip();
      if (account) await refreshState();
    } catch {
      // Wallets may reject passive reads while locked; the connect button remains.
    }
  })();
} else {
  setStatus('No EVM wallet detected. Install MetaMask or a compatible wallet to view your Green Flock NFTs.');
}

// ── Staking status banner ──────────────────────────────────────────────────────
// The copy below has to stay truthful about three separate facts: the contract is
// deployed, the rarity tiers are not written on-chain yet, and the reward vault is
// still empty. Both the headline and the detail line are script-driven so the
// wording never drifts from the actual gate state.
if (DEMO_MODE) {
  show('demoBanner');
  show('stakingNotice');
  setText('stakingStatusText', 'Preview mode — synthetic data, no chain access.');
  setText('stakingStatusDetail', 'Numbers on this page are generated locally for layout review. No wallet is read and no transaction can be sent.');
} else if (STAKING_ACTIVE) {
  hide('stakingNotice');
} else {
  setText('stakingStatusText', 'Green Flock staking contract is live on Robinhood Chain.');
  setText(
    'stakingStatusDetail',
    'Wallet discovery is open now, and the rarity table for all 3,333 Green Flock NFTs is finalised. '
      + 'Two on-chain steps remain before staking, reward claims, and unstaking are switched on: '
      + 'writing the rarity tiers to the contract, and depositing the $ROBINPUMP reward vault.'
  );
}

// ── Staking contract card ──────────────────────────────────────────────────────
// The card in the "On-Chain Configuration" grid states a deployment fact, so it is
// driven from the same gate as everything else. The HTML carries the "activation
// pending" wording as its default; once the gate opens this rewrites it instead of
// leaving a second copy of the status to drift out of sync.
if (STAKING_ACTIVE) {
  setText('stakingContractStatus', 'Active — staking open');
  setText('stakingContractNote', 'Staking, reward claims, and unstaking are live. Rewards accrue per second against the rarity tier of each token ID.');
  const statusEl = $('stakingContractStatus');
  if (statusEl) statusEl.classList.remove('status-pending-text');
} else if (DEMO_MODE) {
  setText('stakingContractStatus', 'Preview mode');
  setText('stakingContractNote', 'This page is running on synthetic data. The address above is the real deployment, but no call is made to it in preview mode.');
}
