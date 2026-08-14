'use strict';

/*
 * RobinPump Green Flock — Staking UI
 *
 * Source of truth: Robinhood Chain (chain ID 4663).
 * No NFT ownership, staking state, reward, or transaction state is persisted
 * in localStorage, sessionStorage, or any browser-side database.
 *
 * Staking transactions are DISABLED until STAKING_CONTRACT_ADDRESS is set
 * in staking-config.js and the audited contract is deployed.
 */

const CFG = window.RobinPumpStakingConfig;
const EXPLORER = CFG.network.explorerUrl;
const STAKING_ACTIVE = !!(CFG.stakingContract);

// ── Selector helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const show = id => { const el = $(id); if (el) el.hidden = false; };
const hide = id => { const el = $(id); if (el) el.hidden = true; };

function updateHeaderWalletAction(connected) {
  const button = $('connectWalletNav');
  if (!button) return;
  button.textContent = connected ? 'Disconnect' : 'Connect Wallet';
  button.setAttribute('aria-label', connected ? 'Disconnect wallet from RobinPump' : 'Connect wallet');
  button.classList.toggle('btn-outline', connected);
  button.classList.toggle('btn-primary', !connected);
}

// ── State ────────────────────────────────────────────────────────────────────
let account = null;
let onCorrectChain = false;
let detectedChainId = null;
let nftData = [];          // [{tokenId, metadata, tier, stakedStatus, pending}]
let refreshLock = false;
let activeTab = 'available';

// ── Tier config (display/estimation only — contract is authoritative) ────────
const TIER_CONFIG = Object.freeze({
  LEGENDARY: { label: 'Legendary', ratePerDay: 1000,       cssClass: 'tier-legendary', rewardBasis: 1 },
  EPIC:      { label: 'Epic',      ratePerDay: 333.333333,  cssClass: 'tier-epic',      rewardBasis: 3 },
  RARE:      { label: 'Rare',      ratePerDay: 111.111111,  cssClass: 'tier-rare',      rewardBasis: 9 },
  UNCOMMON:  { label: 'Uncommon',  ratePerDay: 37.037037,   cssClass: 'tier-uncommon',  rewardBasis: 27 },
  COMMON:    { label: 'Common',    ratePerDay: 12.345679,   cssClass: 'tier-common',    rewardBasis: 81 }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
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

function toGateway(uri) {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}

function getTierFromMetadata(metadata) {
  const attrs = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
  const trait = attrs.find(a => /^(tier|rarity)$/i.test(String(a?.trait_type || '')));
  const key = String(trait?.value || '').trim().toUpperCase();
  return TIER_CONFIG[key] ? key : null;
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

function updateDetectedNetwork(chainId) {
  detectedChainId = chainId;
  const isExpected = isRobinhoodChain(chainId);
  setText('walletNetwork', isExpected ? `${CFG.network.label} · ${describeChain(chainId)}` : describeChain(chainId));
  setText('detectedNetworkText', isExpected
    ? `${CFG.network.label} detected. Refreshing your on-chain Green Flock data…`
    : `Your wallet is connected to ${describeChain(chainId)}. Switch to Robinhood Chain (Chain ID: ${CFG.network.chainId}) to view Green Flock NFTs.`);
  if (isExpected) hide('wrongNetworkPrompt');
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
    await rpc('wallet_addEthereumChain', [{
      chainId: CFG.network.chainIdHex,
      chainName: CFG.network.label,
      nativeCurrency: { name: 'Ether', symbol: CFG.network.currencySymbol, decimals: 18 },
      rpcUrls: [CFG.network.rpcUrl],
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

async function getOwnedTokenIds(owner) {
  const nftAddr = CFG.greenFlockCollection.address;
  const ownerTopic = `0x${encodeAddr(owner)}`;
  const base = { address: nftAddr, fromBlock: '0x0', toBlock: 'latest' };
  const [incoming, outgoing] = await Promise.all([
    rpc('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, null, ownerTopic] }]),
    rpc('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, ownerTopic] }])
  ]);
  // Deduplicate by tx+logIndex, then replay chronologically
  const eventMap = new Map();
  [...incoming, ...outgoing].forEach(e => eventMap.set(`${e.transactionHash}:${e.logIndex}`, e));
  const owned = new Set();
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
      if (to === owner.toLowerCase())   owned.add(tokenId);
      if (from === owner.toLowerCase()) owned.delete(tokenId);
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
    const res = await fetch(toGateway(uri));
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Toast notifications ────────────────────────────────────────────────────────
let toastId = 0;
function toast(type, title, body = '', txHash = '') {
  const container = $('toastContainer');
  if (!container) return;
  const id = ++toastId;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'alert');
  el.dataset.toastId = id;

  const iconMap = {
    info:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    loading: '<div class="spinner spinner--sm" aria-hidden="true"></div>'
  };

  let inner = `<div class="toast-icon">${iconMap[type] || iconMap.info}</div><div class="toast-body"><strong>${title}</strong>`;
  if (body) inner += `<p>${body}</p>`;
  if (txHash) inner += `<a href="${EXPLORER}/tx/${txHash}" target="_blank" rel="noopener noreferrer" class="toast-tx">View on Explorer ↗</a>`;
  inner += '</div><button class="toast-close" aria-label="Dismiss">✕</button>';
  el.innerHTML = inner;
  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  container.appendChild(el);

  const duration = type === 'error' ? 8000 : type === 'loading' ? 0 : 5000;
  if (duration > 0) setTimeout(() => el.remove(), duration);
  return { el, update(t, b, tx) { el.className = `toast toast--${t}`; el.querySelector('.toast-icon').innerHTML = iconMap[t] || iconMap.info; el.querySelector('strong').textContent = b; const p = el.querySelector('p'); if (p) p.textContent = tx || ''; } };
}

// ── NFT Card rendering ─────────────────────────────────────────────────────────
function buildNftCard(nft, staked = false) {
  const { tokenId, metadata, tier } = nft;
  const title = metadata?.name || `RobinPump Green Flock #${String(tokenId).padStart(4, '0')}`;
  const image = metadata?.image ? toGateway(metadata.image) : '';
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
    img.className = 'nft-artwork';
    img.onerror = () => { img.replaceWith(buildFallback()); };
    imgWrap.appendChild(img);
  } else {
    imgWrap.appendChild(buildFallback());
  }
  card.appendChild(imgWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'nft-card-body';

  const idLabel = document.createElement('p');
  idLabel.className = 'nft-token-id';
  idLabel.textContent = `#${String(tokenId).padStart(4, '0')}`;

  const nameEl = document.createElement('h3');
  nameEl.textContent = title;

  // Tier badge
  if (tierCfg) {
    const tierBadge = document.createElement('span');
    tierBadge.className = `nft-tier-badge ${tierCfg.cssClass}`;
    tierBadge.textContent = tierCfg.label;
    body.appendChild(tierBadge);
  } else {
    const unknownBadge = document.createElement('span');
    unknownBadge.className = 'nft-tier-badge tier-unknown';
    unknownBadge.textContent = 'Tier unknown';
    body.appendChild(unknownBadge);
  }

  body.appendChild(idLabel);
  body.appendChild(nameEl);

  // Rate
  const rateEl = document.createElement('p');
  rateEl.className = 'nft-rate';
  rateEl.textContent = tierCfg
    ? `${tierCfg.ratePerDay.toLocaleString(undefined, { maximumFractionDigits: 6 })} $ROBINPUMP / day`
    : 'Rate: requires staking contract';
  body.appendChild(rateEl);

  // Pending (staked only)
  if (staked) {
    const pendingEl = document.createElement('div');
    pendingEl.className = 'nft-pending';
    pendingEl.innerHTML = `<span>Pending</span><strong id="pending-${tokenId}">—</strong>`;
    body.appendChild(pendingEl);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'nft-actions';

  if (!STAKING_ACTIVE) {
    const disabledBtn = document.createElement('button');
    disabledBtn.type = 'button';
    disabledBtn.className = 'btn btn-outline btn-sm';
    disabledBtn.disabled = true;
    disabledBtn.setAttribute('aria-disabled', 'true');
    disabledBtn.textContent = staked ? 'Unstake (coming soon)' : 'Stake (coming soon)';
    disabledBtn.title = 'Staking contract not yet deployed';
    actions.appendChild(disabledBtn);
  } else {
    if (staked) {
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
    } else {
      const stakeBtn = document.createElement('button');
      stakeBtn.type = 'button';
      stakeBtn.className = 'btn btn-primary btn-sm';
      stakeBtn.textContent = 'Stake';
      stakeBtn.dataset.action = 'stake';
      stakeBtn.dataset.tokenId = tokenId;
      actions.appendChild(stakeBtn);
    }
  }
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

function buildFallback() {
  const d = document.createElement('div');
  d.className = 'nft-artwork nft-artwork-fallback';
  d.textContent = 'Image unavailable';
  return d;
}

// ── Dashboard rendering ────────────────────────────────────────────────────────
function renderDashboard() {
  const available = nftData.filter(n => !n.staked);
  const staked    = nftData.filter(n => n.staked);

  // Tab counts
  setText('tabCountAvailable', available.length);
  setText('tabCountStaked', staked.length);

  // Available grid
  const gridAvail = $('nftGridAvailable');
  gridAvail.replaceChildren();
  available.forEach(n => gridAvail.appendChild(buildNftCard(n, false)));
  $('emptyAvailable').hidden = available.length > 0;

  // Staked grid
  const gridStaked = $('nftGridStaked');
  gridStaked.replaceChildren();
  staked.forEach(n => gridStaked.appendChild(buildNftCard(n, true)));
  $('emptyStaked').hidden = staked.length > 0;

  // Show/hide grids based on active tab
  $('nftGridAvailable').hidden = activeTab !== 'available';
  $('emptyAvailable').hidden   = activeTab !== 'available' || available.length > 0;
  $('nftGridStaked').hidden    = activeTab !== 'staked';
  $('emptyStaked').hidden      = activeTab !== 'staked' || staked.length > 0;

  // Stats
  const dailyTotal = staked.reduce((sum, n) => {
    const t = n.tier ? TIER_CONFIG[n.tier] : null;
    return sum + (t ? t.ratePerDay : 0);
  }, 0);
  setText('statYourNfts', nftData.length);
  setText('statStaked', staked.length);
  setText('statDaily', staked.length
    ? `${dailyTotal.toLocaleString(undefined, { maximumFractionDigits: 6 })} /day`
    : '—');

  // Claim all bar
  if (staked.length > 0 && STAKING_ACTIVE) {
    show('claimAllBar');
  } else {
    hide('claimAllBar');
  }

  show('dashboardTabs');
}

function updateTabDisplay() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('tab-btn--active', b.dataset.tab === activeTab);
  });
  $('nftGridAvailable').hidden = activeTab !== 'available';
  $('emptyAvailable').hidden   = activeTab !== 'available' || nftData.filter(n => !n.staked).length > 0;
  $('nftGridStaked').hidden    = activeTab !== 'staked';
  $('emptyStaked').hidden      = activeTab !== 'staked' || nftData.filter(n => n.staked).length > 0;
}

// ── Main refresh ───────────────────────────────────────────────────────────────
async function refreshState() {
  if (!account || refreshLock) return;
  refreshLock = true;
  show('nftLoading');
  hide('runtimeStatus');

  try {
    // 1. Check chain
    const chainId = await rpc('eth_chainId');
    updateDetectedNetwork(chainId);
    onCorrectChain = isRobinhoodChain(chainId);
    setText('walletShort', shortAddress(account));
    $('walletInfo').hidden = false;
    updateHeaderWalletAction(true);
    if (!onCorrectChain) {
      hide('stakingDashboard');
      hide('connectPrompt');
      show('wrongNetworkPrompt');
      hide('nftLoading');
      refreshLock = false;
      return;
    }
    hide('wrongNetworkPrompt');
    hide('connectPrompt');
    show('stakingDashboard');

    // 2. Wallet short display
    setText('walletNetwork', `${CFG.network.label} · ${describeChain(chainId)}`);

    // 3. Read token balance
    const balRaw = await call(CFG.rewardToken.address, `0x70a08231${encodeAddr(account)}`);
    const balance = formatUnits(decodeUint(balRaw), CFG.rewardToken.decimals);
    setText('statBalance', `${balance} ROBINPUMP`);

    // 4. Read NFT balance + ownership
    setText('nftLoadingText', 'Indexing Transfer events for your wallet…');
    const [nftBalRaw, tokenIds] = await Promise.all([
      call(CFG.greenFlockCollection.address, `0x70a08231${encodeAddr(account)}`),
      getOwnedTokenIds(account)
    ]);
    const nftBalance = decodeUint(nftBalRaw);
    if (nftBalance !== BigInt(tokenIds.length)) {
      throw new Error('NFT ownership index is still syncing. Please try again shortly.');
    }
    setText('statYourNfts', nftBalance.toString());

    // 5. Fetch metadata for each owned NFT (parallel, lazy)
    setText('nftLoadingText', `Loading metadata for ${tokenIds.length} NFT${tokenIds.length !== 1 ? 's' : ''}…`);
    nftData = await Promise.all(
      tokenIds.map(async tokenId => {
        const metadata = await fetchMetadata(tokenId);
        const tier = getTierFromMetadata(metadata);
        // staked = false until staking contract is live
        return { tokenId, metadata, tier, staked: false, pending: '0' };
      })
    );

    // 6. If staking contract is live, read staking state (disabled until deployed)
    if (STAKING_ACTIVE && CFG.stakingContract) {
      // Future: call stakedTokenIds(account) and pendingReward(tokenId) on staking contract
    }

    // 7. Update collection name
    const nameRaw = await call(CFG.greenFlockCollection.address, '0x06fdde03');
    const collName = decodeString(nameRaw) || 'Green Flock';
    setText('collectionName', collName);
    setText('collectionStatus', 'ERC-721 verified');

    renderDashboard();

    // Runtime status
    const statusEl = $('runtimeStatus');
    statusEl.textContent = tokenIds.length
      ? `${tokenIds.length} Green Flock NFT${tokenIds.length !== 1 ? 's' : ''} found. Staking will be enabled once the staking contract is deployed.`
      : 'No Green Flock NFTs found in this wallet.';
    statusEl.hidden = false;

  } catch (err) {
    const statusEl = $('runtimeStatus');
    statusEl.textContent = friendlyError(err);
    statusEl.hidden = false;
    show('stakingDashboard');
  } finally {
    hide('nftLoading');
    refreshLock = false;
  }
}

// ── Wallet connection ──────────────────────────────────────────────────────────
async function connectWallet(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  try {
    await ensureRobinhoodChain();
    const accounts = await rpc('eth_requestAccounts');
    account = accounts?.[0] || null;
    if (!account) throw new Error('No account selected in wallet.');
    hide('connectPrompt');
    await refreshState();
  } catch (err) {
    if (err.code === 4001) {
      toast('error', 'Wallet connection rejected.', 'You declined the connection request in your wallet.');
    } else {
      toast('error', 'Connection failed.', friendlyError(err));
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Connect Wallet'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function disconnectWallet() {
  resetState();
  toast('info', 'Wallet disconnected.', 'RobinPump has cleared this browser session. Your wallet remains under your control.');
}

function resetState() {
  account = null;
  onCorrectChain = false;
  nftData = [];
  hide('stakingDashboard');
  hide('wrongNetworkPrompt');
  show('connectPrompt');
  hide('walletInfo');
  updateHeaderWalletAction(false);
  setText('statYourNfts', '—');
  setText('statStaked', '—');
  setText('statDaily', '—');
  setText('statPending', '—');
  setText('statBalance', '—');
  const statusEl = $('runtimeStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.hidden = true; }
}

// ── Error messages ─────────────────────────────────────────────────────────────
function friendlyError(err) {
  if (!err) return 'Unknown error.';
  const msg = err?.message || String(err);
  if (err.code === 4001 || msg.includes('rejected') || msg.includes('denied')) return 'Transaction rejected in your wallet.';
  if (msg.includes('insufficient funds') || msg.includes('gas')) return 'Insufficient ETH for gas fees.';
  if (msg.includes('nonce')) return 'Nonce mismatch — please reset your wallet pending transactions.';
  if (msg.includes('stale') || msg.includes('index')) return 'NFT index is being updated. Please try again in a moment.';
  if (msg.includes('No EVM wallet')) return msg;
  if (msg.length > 120) return msg.slice(0, 120) + '…';
  return msg;
}

// ── Staking actions (disabled until contract deployed) ─────────────────────────
async function handleStake(tokenId) {
  if (!STAKING_ACTIVE) { toast('info', 'Staking not active yet.', 'The staking contract has not been deployed. Check back soon.'); return; }
  // Future implementation: approve + stake
  toast('info', 'Coming soon.', `Staking contract required for token #${tokenId}.`);
}

async function handleUnstake(tokenId) {
  if (!STAKING_ACTIVE) { toast('info', 'Staking not active yet.'); return; }
  toast('info', 'Coming soon.', `Unstaking contract required for token #${tokenId}.`);
}

async function handleClaim(tokenId) {
  if (!STAKING_ACTIVE) { toast('info', 'Staking not active yet.'); return; }
  toast('info', 'Coming soon.', `Claim contract required for token #${tokenId}.`);
}

// ── Supply display ─────────────────────────────────────────────────────────────
(async () => {
  try {
    const supplyRaw = await call(CFG.rewardToken.address, '0x18160ddd');
    const supply = formatUnits(decodeUint(supplyRaw), CFG.rewardToken.decimals, 0);
    setText('rewardSupply', `${supply} ROBINPUMP`);
  } catch { setText('rewardSupply', '1,000,000,000 ROBINPUMP'); }
})();

// ── Event delegation ───────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !account) return;
  const { action, tokenId } = btn.dataset;
  if (action === 'stake')   handleStake(tokenId);
  if (action === 'unstake') handleUnstake(tokenId);
  if (action === 'claim')   handleClaim(tokenId);
});

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    updateTabDisplay();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-btn--active', b.dataset.tab === activeTab));
  });
});

// Connect buttons
$('connectWalletNav')?.addEventListener('click', () => {
  if (account) disconnectWallet();
  else connectWallet($('connectWalletNav'));
});
$('switchNetworkBtn')?.addEventListener('click', async () => {
  try { await ensureRobinhoodChain(); await refreshState(); }
  catch (err) { toast('error', 'Network switch failed.', friendlyError(err)); }
});
$('claimAllBtn')?.addEventListener('click', () => {
  if (!STAKING_ACTIVE) toast('info', 'Staking not active yet.');
});

// Copy buttons
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

// Wallet events
if (window.ethereum) {
  window.ethereum.on('accountsChanged', accs => {
    account = accs?.[0] || null;
    account ? refreshState() : resetState();
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
      if (account) {
        hide('connectPrompt');
        await refreshState();
      }
    } catch {
      // Wallets may reject passive reads while locked; the explicit connect button remains available.
    }
  })();
}

// Staking contract status banner
if (STAKING_ACTIVE) {
  const notice = $('stakingNotice');
  if (notice) {
    notice.style.borderColor = 'rgba(0,255,136,0.4)';
    notice.style.background  = 'rgba(0,255,136,0.06)';
    notice.querySelector('strong').style.color = 'var(--green)';
  }
  setText('stakingStatusText', 'Staking is live. Connect your wallet to stake your NFTs.');
  hide('stakingNotice'); // hide the banner if staking is active
}
