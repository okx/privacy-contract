// UI Update and DOM Management
import { formatAddress, formatMPK, formatBalance, getTimeAgo } from './utils.js';
import { erc20TokenInfo, CONFIG } from './config.js';

// DOM Cache for performance
class DOMCache {
  constructor() {
    this.elements = {};
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;

    this.elements = {
      // Connect button
      connectBtn: document.getElementById('connect-btn'),
      
      // Balance displays
      publicBalanceElements: document.querySelectorAll('.balance-value.public'),
      privateBalanceElements: document.querySelectorAll('.balance-value.private'),
      tokenInfoEl: document.getElementById('erc20-token-info'),
      
      // MPK lookups (shield modal only)
      shieldMpk: document.getElementById('shield-mpk'),
      shieldViewPubKey: document.getElementById('shield-viewpubkey'),
      shieldStatus: document.getElementById('shield-status'),
      
      // History
      historyList: document.querySelector('.history-list'),
      
      // Input suffixes
      inputSuffixes: document.querySelectorAll('.input-suffix')
    };

    this.initialized = true;
  }

  get(key) {
    if (!this.initialized) this.init();
    return this.elements[key];
  }

  refresh(key) {
    // Refresh specific element if it was removed/recreated
    const selectors = {
      // Add as needed
    };
    
    if (selectors[key]) {
      this.elements[key] = document.querySelector(selectors[key]);
    }
  }
}

export const domCache = new DOMCache();

// UI Update Functions
export function updateConnectButton(state) {
  const connectBtn = domCache.get('connectBtn');
  if (!connectBtn) return;
  
  const privacyToggle = document.getElementById('privacy-mode-toggle');
  const privacyStatus = document.getElementById('privacy-status');
  
  if (state.account) {
    connectBtn.textContent = formatAddress(state.account) + ' ▾';
    connectBtn.classList.add('connected');
    
    // Enable privacy toggle when connected
    if (privacyToggle) {
      privacyToggle.disabled = false;
    }
  } else {
    connectBtn.textContent = 'Connect Wallet';
    connectBtn.classList.remove('connected');
    
    // Disable privacy toggle when disconnected
    if (privacyToggle) {
      privacyToggle.disabled = true;
      privacyToggle.checked = false;
    }
    
    // Update status text when not connected
    if (privacyStatus) {
      const statusText = privacyStatus.querySelector('.status-text');
      const statusDot = privacyStatus.querySelector('.status-dot');
      if (statusText) {
        statusText.textContent = 'Not registered';
      }
      if (statusDot) {
        statusDot.classList.remove('registered');
        statusDot.classList.add('unregistered');
      }
    }
  }
}

export function updateBalances(state) {
  const publicElements = domCache.get('publicBalanceElements');
  const privateElements = domCache.get('privateBalanceElements');
  
  publicElements.forEach(el => {
    el.textContent = state.publicBalance + ' ' + erc20TokenInfo.symbol;
  });
  
  privateElements.forEach(el => {
    el.textContent = state.privateBalance + ' ' + erc20TokenInfo.symbol;
  });
  
  // Update Privacy Overview
  updatePrivacyOverview(state);
}

function updatePrivacyOverview(state) {
  const totalEl = document.getElementById('overview-total');
  const ratioEl = document.getElementById('overview-ratio');
  const fillEl = document.getElementById('privacy-ratio-fill');
  const lastActiveEl = document.getElementById('overview-last-active');
  
  const publicBalance = parseFloat(state.publicBalance) || 0;
  const privateBalance = parseFloat(state.privateBalance) || 0;
  const total = publicBalance + privateBalance;
  
  if (totalEl) {
    totalEl.textContent = total.toFixed(2) + ' ' + erc20TokenInfo.symbol;
  }
  
  if (total > 0) {
    const ratio = Math.round((privateBalance / total) * 100);
    if (ratioEl) ratioEl.textContent = ratio + '%';
    if (fillEl) fillEl.style.width = ratio + '%';
  } else {
    if (ratioEl) ratioEl.textContent = '0%';
    if (fillEl) fillEl.style.width = '0%';
  }
  
  if (lastActiveEl && state.transactions.length > 0) {
    const latestTx = state.transactions[0];
    lastActiveEl.textContent = getTimeAgo(latestTx.timestamp);
  } else if (lastActiveEl) {
    lastActiveEl.textContent = '—';
  }
}

// Account info removed - using Connect button in header instead
export function updateAccountInfo(state) {
  // No longer needed - account info removed from sidebar
}

// MPK display removed - using Privacy Mode toggle status instead
export function updateMPKDisplay(state, derivedKeys) {
  // Update Shield button state based on registration
  updateShieldButtonState(state.isRegistered);
  
  // Update Privacy Mode status
  updatePrivacyModeStatus(state.isRegistered);
}

// Update Privacy Mode status in sidebar
function updatePrivacyModeStatus(isRegistered) {
  const privacyStatus = document.getElementById('privacy-status');
  if (!privacyStatus) return;
  
  const statusDot = privacyStatus.querySelector('.status-dot');
  const statusText = privacyStatus.querySelector('.status-text');
  const privacyToggle = document.getElementById('privacy-mode-toggle');
  
  if (!statusDot || !statusText) return;
  
  if (isRegistered) {
    // User is registered
    if (privacyToggle && privacyToggle.checked) {
      // Privacy mode ON
      statusDot.classList.remove('unregistered');
      statusDot.classList.add('registered');
      statusText.textContent = 'Activated';
    } else {
      // Privacy mode OFF but registered - use red dot to indicate not activated
      statusDot.classList.remove('registered');
      statusDot.classList.add('unregistered');
      statusText.textContent = 'Not activated';
    }
  } else {
    // User is not registered
    statusDot.classList.remove('registered');
    statusDot.classList.add('unregistered');
    
    if (privacyToggle && privacyToggle.checked) {
      statusText.textContent = 'Registering...';
    } else {
      statusText.textContent = 'Not registered';
    }
  }
}

// Update Shield button enabled/disabled state
function updateShieldButtonState(isRegistered) {
  const shieldBtn = document.getElementById('shield-btn');
  const sidebarShieldBtn = document.getElementById('sidebar-shield-btn');
  const sidebarUnshieldBtn = document.getElementById('sidebar-unshield-btn');
  const convertActionBtn = document.getElementById('convert-action-btn');
  
  const buttons = [shieldBtn, sidebarShieldBtn, sidebarUnshieldBtn, convertActionBtn].filter(btn => btn);
  
  buttons.forEach(btn => {
    if (isRegistered) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.title = '';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.title = 'Please activate Privacy Mode first';
    }
  });
}

// updateAddressInputs - removed, no longer needed

export function updateERC20TokenDisplay() {
  // Update token symbol in balance displays
  const publicElements = domCache.get('publicBalanceElements');
  const privateElements = domCache.get('privateBalanceElements');
  
  publicElements.forEach(el => {
    const amount = el.textContent.split(' ')[0];
    el.textContent = amount + ' ' + erc20TokenInfo.symbol;
  });
  
  privateElements.forEach(el => {
    const amount = el.textContent.split(' ')[0];
    el.textContent = amount + ' ' + erc20TokenInfo.symbol;
  });
  
  // Update input suffixes
  const suffixes = domCache.get('inputSuffixes');
  suffixes.forEach(el => {
    el.textContent = erc20TokenInfo.symbol;
  });
  
  // Update token info display
  const tokenInfoEl = domCache.get('tokenInfoEl');
  if (tokenInfoEl && erc20TokenInfo.address) {
    tokenInfoEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        ${erc20TokenInfo.symbol ? `<span style="font-weight: 600; color: var(--text-primary);">${erc20TokenInfo.symbol}</span>` : ''}
        ${erc20TokenInfo.name ? `<span style="font-size: 11px; color: var(--text-muted);">${erc20TokenInfo.name}</span>` : ''}
        <span style="font-size: 10px; color: var(--text-muted); font-family: monospace;">${formatAddress(erc20TokenInfo.address)}</span>
      </div>
    `;
  }
}

export function updateShieldLookup(mpk, viewPubKey, isFound) {
  const mpkEl = domCache.get('shieldMpk');
  const viewPubKeyEl = domCache.get('shieldViewPubKey');
  const statusEl = domCache.get('shieldStatus');
  
  if (!mpkEl || !statusEl) return;
  
  if (isFound && mpk) {
    mpkEl.textContent = formatMPK(mpk);
    if (viewPubKeyEl && viewPubKey) {
      const short = viewPubKey.length > 20 
        ? viewPubKey.slice(0, 18) + '...' + viewPubKey.slice(-8)
        : viewPubKey;
      viewPubKeyEl.textContent = short;
    }
    statusEl.textContent = '✓ Registered';
    statusEl.className = 'lookup-status found';
  } else {
    mpkEl.textContent = isFound === null ? 'Connect wallet...' : 'Not registered';
    if (viewPubKeyEl) viewPubKeyEl.textContent = '—';
    statusEl.textContent = isFound === null ? '—' : '✗ Not registered';
    statusEl.className = isFound === null ? 'lookup-status' : 'lookup-status not-found';
  }
}

export function updateTransferLookup(mpk, viewPubKey, isFound) {
  const statusDot = document.getElementById('transfer-status-dot');
  const statusHint = document.getElementById('transfer-status-hint');
  
  if (!statusDot || !statusHint) return;
  
  // Determine recipient registration status
  let recipientRegistered = null;
  
  if (isFound === 'checking') {
    // Checking state
    statusDot.className = 'status-dot checking';
    statusHint.textContent = 'Checking...';
    statusHint.className = 'status-hint';
  } else if (isFound && mpk) {
    // Privacy registered
    statusDot.className = 'status-dot registered';
    statusHint.textContent = 'Registered ✓ → Private Transfer (fully private)';
    statusHint.className = 'status-hint found';
    recipientRegistered = true;
  } else if (isFound === false) {
    // Privacy not registered - will use Private to Public
    statusDot.className = 'status-dot unregistered';
    statusHint.textContent = 'Not registered → Will send to public balance';
    statusHint.className = 'status-hint not-found';
    recipientRegistered = false;
  } else if (isFound === 'invalid') {
    // Invalid address
    statusDot.className = 'status-dot unregistered';
    statusHint.textContent = 'Invalid address';
    statusHint.className = 'status-hint not-found';
    recipientRegistered = null;
  } else {
    // Reset state
    statusDot.className = 'status-dot';
    statusHint.textContent = 'Checking recipient status...';
    statusHint.className = 'status-hint';
    recipientRegistered = null;
  }
  
  // Update flow indicator if function exists (defined in app.js)
  if (typeof window.updateTransferFlow === 'function') {
    const privacyModeToggle = document.getElementById('privacy-mode-toggle');
    const usePrivacy = privacyModeToggle?.checked || false;
    window.updateTransferFlow(usePrivacy, recipientRegistered);
  }
}

export function updateTransactionHistory(transactions) {
  // Update both sidebar history (if exists) and activity list
  const historyList = domCache.get('historyList');
  const activityList = document.getElementById('activity-list');
  
  const generateHistoryHTML = (txs, maxCount) => {
    if (txs.length === 0) {
      return `
        <div style="text-align: center; padding: 20px; color: var(--text-muted);">
          <p>No transactions yet</p>
        </div>
      `;
    }
    
    return txs.slice(0, maxCount).map((tx, index) => `
      <div class="history-item" data-tx-index="${index}">
        <div class="history-icon ${tx.type}-tx">${tx.icon}</div>
        <div class="history-info">
          <h4>${tx.title}${tx.status === 'failed' ? ' ❌' : tx.status === 'pending' ? ' ⏳' : ' ✅'}</h4>
          <p>${tx.description}</p>
        </div>
        <div class="history-amount">
          <div class="value">${tx.amount}</div>
          <div class="time">${getTimeAgo(tx.timestamp)}</div>
        </div>
      </div>
    `).join('');
  };
  
  // Update sidebar history (if exists) - show 5 items
  if (historyList) {
    historyList.innerHTML = generateHistoryHTML(transactions, 5);
    
    historyList.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.txIndex);
        window.dispatchEvent(new CustomEvent('show-transaction', { detail: { index } }));
      });
    });
  }
  
  // Update activity list - show 10 items
  if (activityList) {
    activityList.innerHTML = generateHistoryHTML(transactions, 10);
    
    activityList.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.txIndex);
        window.dispatchEvent(new CustomEvent('show-transaction', { detail: { index } }));
      });
    });
  }
}

export function showTransactionDetails(tx, chainId) {
  // Hide transfer panel and show transaction detail view
  const transferPanel = document.getElementById('transfer-panel');
  const detailView = document.getElementById('transaction-detail-view');
  
  if (!detailView) return;
  
  if (transferPanel) {
    transferPanel.style.display = 'none';
  }
  
  detailView.style.display = 'block';
  
  const container = detailView;

  const statusIcon = tx.status === 'success' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
  const statusText = tx.status === 'success' ? 'Success' : tx.status === 'pending' ? 'Pending' : 'Failed';
  const statusColor = tx.status === 'success' ? 'var(--accent-green)' : tx.status === 'pending' ? 'var(--accent-orange)' : 'var(--danger)';

  container.innerHTML = `
    <div class="transaction-detail-card">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="panel-icon" style="width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--accent-blue-dim); color: var(--accent-blue);">📋</div>
          <div>
            <h2 style="margin: 0; font-size: 22px; font-weight: 600;">Transaction Details</h2>
            <p style="margin: 4px 0 0 0; font-size: 13px; color: var(--text-secondary);">View transaction information</p>
          </div>
        </div>
        <button class="back-to-list-btn" style="padding: 8px 16px; background: var(--bg-dark); color: var(--text-primary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          ← Back
        </button>
      </div>
      
      <div class="transaction-detail-header" style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border);">
        <div style="font-size: 32px;">${tx.icon}</div>
        <div style="flex: 1;">
          <h3 style="margin: 0 0 4px 0;">${tx.title}</h3>
          <p style="margin: 0; color: var(--text-muted); font-size: 14px;">${tx.description}</p>
        </div>
        <div style="padding: 8px 16px; background: ${statusColor}20; color: ${statusColor}; border-radius: 8px; font-weight: 600;">
          ${statusIcon} ${statusText}
        </div>
      </div>

      <div class="transaction-detail-info" style="display: flex; flex-direction: column; gap: 16px;">
        <div class="detail-row" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-dark); border-radius: 8px;">
          <span style="color: var(--text-muted);">Amount:</span>
          <span style="font-weight: 600; font-size: 18px;">${tx.amount}</span>
        </div>

        <div class="detail-row" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-dark); border-radius: 8px;">
          <span style="color: var(--text-muted);">Time:</span>
          <span>${new Date(tx.timestamp).toLocaleString()} (${getTimeAgo(tx.timestamp)})</span>
        </div>

        ${tx.txHash ? `
          <div class="detail-row" style="padding: 12px; background: var(--bg-dark); border-radius: 8px;">
            <div style="margin-bottom: 8px; color: var(--text-muted);">Transaction Hash:</div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <code style="flex: 1; font-family: monospace; font-size: 13px; word-break: break-all; background: var(--bg-card); padding: 8px; border-radius: 6px; user-select: all; cursor: text;">${tx.txHash}</code>
              <button class="copy-hash-btn" data-hash="${tx.txHash}" style="padding: 8px 12px; background: var(--accent-blue); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap;">Copy</button>
            </div>
            ${chainId === 1337 ? `
              <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">Local network - no explorer available</div>
            ` : CONFIG.TARGET_CHAIN.blockExplorerUrl ? `
              <a href="${CONFIG.TARGET_CHAIN.blockExplorerUrl}/tx/${tx.txHash}" target="_blank" style="margin-top: 8px; display: inline-block; font-size: 12px; color: var(--accent-blue); text-decoration: none;">View on Explorer →</a>
            ` : `
              <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">Explorer not configured</div>
            `}
          </div>
        ` : `
          <div class="detail-row" style="padding: 12px; background: var(--bg-dark); border-radius: 8px; color: var(--text-muted);">
            ⚠️ Transaction hash not available
          </div>
        `}
      </div>
    </div>
  `;
  
  // Add event listeners
  const backBtn = container.querySelector('.back-to-list-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      // Hide detail view and show transfer panel
      const transferPanel = document.getElementById('transfer-panel');
      const detailView = document.getElementById('transaction-detail-view');
      
      if (detailView) {
        detailView.style.display = 'none';
      }
      if (transferPanel) {
        transferPanel.style.display = 'block';
      }
    });
  }
  
  const copyBtn = container.querySelector('.copy-hash-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async (e) => {
      const hash = e.target.dataset.hash;
      window.dispatchEvent(new CustomEvent('copy-to-clipboard', { detail: { text: hash } }));
    });
  }
}

export function showTransactionList(transactions) {
  const container = document.getElementById('transaction-details-container');
  if (!container) return;

  if (transactions.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <p>No transactions yet</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${transactions.map((tx, index) => `
        <div class="history-item" data-tx-index="${index}">
          <div class="history-icon ${tx.type}-tx">${tx.icon}</div>
          <div class="history-info" style="flex: 1;">
            <h4>${tx.title}${tx.status === 'failed' ? ' ❌' : tx.status === 'pending' ? ' ⏳' : ' ✅'}</h4>
            <p>${tx.description}</p>
            ${tx.txHash ? `<p style="font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: monospace;">${tx.txHash.slice(0, 10)}...${tx.txHash.slice(-8)}</p>` : ''}
          </div>
          <div class="history-amount">
            <div class="value">${tx.amount}</div>
            <div class="time">${getTimeAgo(tx.timestamp)}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  
  // Add click listeners
  container.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.txIndex);
      window.dispatchEvent(new CustomEvent('show-transaction', { detail: { index } }));
    });
  });
}

// switchTab function removed - no longer needed (single page layout)

export function setButtonLoading(selector, isLoading, loadingText = 'Loading...') {
  const btn = document.querySelector(selector);
  if (!btn) return;
  
  if (isLoading) {
    // Only save original text once (when button is not loading yet)
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
  } else {
    btn.disabled = false;
    
    // For convert-action-btn, restore based on current mode
    if (selector === '#convert-action-btn') {
      // Don't use saved text, determine from class
      if (btn.classList.contains('shield')) {
        btn.textContent = 'Public to Private';
      } else if (btn.classList.contains('unshield')) {
        btn.textContent = 'Private to Public';
      } else {
        btn.textContent = btn.dataset.originalText || 'Public to Private';
      }
    } else {
      btn.textContent = btn.dataset.originalText || btn.textContent;
    }
    
    // Clear the saved text after restoring
    delete btn.dataset.originalText;
  }
}
