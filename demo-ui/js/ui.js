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
      
      // Account info
      accountInfoEl: document.querySelector('.account-info'),
      accountAddress: document.querySelector('.account-info p'),
      
      // MPK section
      mpkValue: document.querySelector('.mpk-value'),
      mpkStatus: document.querySelector('.mpk-status'),
      statusDot: document.querySelector('.status-dot'),
      statusText: document.querySelector('.status-text'),
      
      // MPK lookups
      shieldMpk: document.getElementById('shield-mpk'),
      shieldViewPubKey: document.getElementById('shield-viewpubkey'),
      shieldStatus: document.getElementById('shield-status'),
      transferMpk: document.getElementById('transfer-mpk'),
      transferViewPubKey: document.getElementById('transfer-viewpubkey'),
      transferStatus: document.getElementById('transfer-status'),
      
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
      mpkStatus: '.mpk-status',
      // Add more as needed
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
  
  if (state.account) {
    connectBtn.textContent = formatAddress(state.account) + ' ▾';
    connectBtn.classList.add('connected');
  } else {
    connectBtn.textContent = 'Connect Wallet';
    connectBtn.classList.remove('connected');
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
}

export function updateAccountInfo(state) {
  const addressEl = domCache.get('accountAddress');
  if (!addressEl) return;
  
  if (state.account) {
    addressEl.textContent = state.account;
  } else {
    addressEl.textContent = 'Not connected';
  }
}

export function updateMPKDisplay(state, derivedKeys) {
  const mpkValue = domCache.get('mpkValue');
  const mpkStatus = domCache.get('mpkStatus');
  const statusDot = domCache.get('statusDot');
  const statusText = domCache.get('statusText');
  
  if (!mpkValue || !mpkStatus) return;
  
  // Remove existing register button
  const existingBtn = mpkStatus.querySelector('.register-btn');
  if (existingBtn) {
    existingBtn.remove();
  }
  
  if (state.mpk) {
    mpkValue.textContent = formatMPK(state.mpk);
    
    if (statusDot && statusText) {
      if (state.isRegistered) {
        statusDot.className = 'status-dot registered';
        statusText.textContent = 'Registered on-chain';
      } else {
        statusDot.className = 'status-dot unregistered';
        statusText.textContent = 'Not registered';
        
        // Show register button
        if (state.mpk && derivedKeys.viewingPublicKey) {
          const registerBtn = document.createElement('button');
          registerBtn.className = 'register-btn';
          registerBtn.textContent = 'Register MPK';
          registerBtn.onclick = () => {
            window.dispatchEvent(new CustomEvent('register-mpk'));
          };
          mpkStatus.appendChild(registerBtn);
        }
      }
    }
  } else {
    mpkValue.textContent = 'Connect wallet to generate MPK';
    if (statusDot) statusDot.className = 'status-dot unregistered';
    if (statusText) statusText.textContent = state.account ? 'Not connected' : 'Not connected';
  }
  
  // Update Shield button state based on registration
  updateShieldButtonState(state.isRegistered);
}

// Update Shield button enabled/disabled state
function updateShieldButtonState(isRegistered) {
  const shieldBtn = document.querySelector('#shield-panel .submit-btn');
  if (!shieldBtn) return;
  
  if (isRegistered) {
    shieldBtn.disabled = false;
    shieldBtn.style.opacity = '1';
    shieldBtn.style.cursor = 'pointer';
    shieldBtn.title = '';
  } else {
    shieldBtn.disabled = true;
    shieldBtn.style.opacity = '0.5';
    shieldBtn.style.cursor = 'not-allowed';
    shieldBtn.title = 'Please register your MPK first';
  }
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
  const mpkEl = domCache.get('transferMpk');
  const viewPubKeyEl = domCache.get('transferViewPubKey');
  const statusEl = domCache.get('transferStatus');
  
  if (!mpkEl || !statusEl) return;
  
  if (isFound && mpk) {
    mpkEl.textContent = formatMPK(mpk);
    if (viewPubKeyEl && viewPubKey) {
      const short = viewPubKey.length > 20 
        ? viewPubKey.slice(0, 18) + '...' + viewPubKey.slice(-8)
        : viewPubKey;
      viewPubKeyEl.textContent = short;
    }
    statusEl.textContent = '✓ Found';
    statusEl.className = 'lookup-status found';
    updateTransferButtonState(true);
  } else if (isFound === false) {
    mpkEl.textContent = 'Not registered';
    if (viewPubKeyEl) viewPubKeyEl.textContent = '—';
    statusEl.textContent = '✗ Not found';
    statusEl.className = 'lookup-status not-found';
    updateTransferButtonState(false);
  } else if (isFound === 'invalid') {
    mpkEl.textContent = 'Invalid address';
    if (viewPubKeyEl) viewPubKeyEl.textContent = '—';
    statusEl.textContent = 'Invalid';
    statusEl.className = 'lookup-status not-found';
    updateTransferButtonState(false);
  } else {
    mpkEl.textContent = 'Waiting for address...';
    if (viewPubKeyEl) viewPubKeyEl.textContent = '—';
    statusEl.textContent = '—';
    statusEl.className = 'lookup-status';
    updateTransferButtonState(false);
  }
}

// Update Transfer button enabled/disabled state
function updateTransferButtonState(recipientRegistered) {
  const transferBtn = document.querySelector('#transfer-panel .submit-btn');
  if (!transferBtn) return;
  
  if (recipientRegistered) {
    transferBtn.disabled = false;
    transferBtn.style.opacity = '1';
    transferBtn.style.cursor = 'pointer';
    transferBtn.title = '';
  } else {
    transferBtn.disabled = true;
    transferBtn.style.opacity = '0.5';
    transferBtn.style.cursor = 'not-allowed';
    transferBtn.title = 'Recipient must be registered first';
  }
}

export function updateTransactionHistory(transactions) {
  const historyList = domCache.get('historyList');
  if (!historyList) return;

  if (transactions.length === 0) {
    historyList.innerHTML = `
      <div style="text-align: center; padding: 20px; color: var(--text-muted);">
        <p>No transactions yet</p>
      </div>
    `;
    return;
  }

  historyList.innerHTML = transactions.slice(0, 5).map((tx, index) => `
    <div class="history-item" data-tx-index="${index}">
      <div class="history-icon ${tx.type}-tx">${tx.icon}</div>
      <div class="history-info">
        <h4>${tx.title}${tx.status === 'failed' ? ' ❌' : tx.status === 'pending' ? ' ⏳' : ' ✅'}</h4>
        <p>${tx.description}</p>
        ${tx.txHash ? `<p style="font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: monospace;">${tx.txHash.slice(0, 10)}...${tx.txHash.slice(-8)}</p>` : ''}
      </div>
      <div class="history-amount">
        <div class="value">${tx.amount}</div>
        <div class="time">${getTimeAgo(tx.timestamp)}</div>
      </div>
    </div>
  `).join('');
  
  // Add click listeners
  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.txIndex);
      window.dispatchEvent(new CustomEvent('show-transaction', { detail: { index } }));
    });
  });
}

export function showTransactionDetails(tx, chainId) {
  const container = document.getElementById('transaction-details-container');
  if (!container) return;

  const statusIcon = tx.status === 'success' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
  const statusText = tx.status === 'success' ? 'Success' : tx.status === 'pending' ? 'Pending' : 'Failed';
  const statusColor = tx.status === 'success' ? 'var(--accent-green)' : tx.status === 'pending' ? 'var(--accent-orange)' : 'var(--danger)';

  container.innerHTML = `
    <div class="transaction-detail-card" style="max-width: 600px; margin: 0 auto;">
      <button class="back-to-list-btn" style="margin-bottom: 16px; padding: 8px 16px; background: var(--bg-dark); color: var(--text-primary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
        ← Back to List
      </button>
      
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
      window.dispatchEvent(new CustomEvent('show-transaction-list'));
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

export function switchTab(tabName) {
  // Update tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.remove('active', 'shield', 'unshield', 'transfer', 'transactions');
  });
  
  // Find and activate tab
  const tabButton = Array.from(document.querySelectorAll('.tab')).find(btn => 
    btn.textContent.includes(
      tabName === 'shield' ? '🛡️' : 
      tabName === 'unshield' ? '📤' : 
      tabName === 'transfer' ? '🔄' : 
      tabName === 'transactions' ? '📋' : ''
    )
  );
  
  if (tabButton) {
    tabButton.classList.add('active', tabName);
  }

  // Update panels
  document.querySelectorAll('.panel-content').forEach(panel => {
    panel.classList.remove('active');
  });
  
  const panel = document.getElementById(tabName + '-panel');
  if (panel) {
    panel.classList.add('active');
  }
  
  // Show transaction list if switching to transactions tab
  if (tabName === 'transactions') {
    window.dispatchEvent(new CustomEvent('show-transaction-list'));
  }
  
  // Trigger MPK lookup if switching to transfer tab
  if (tabName === 'transfer') {
    window.dispatchEvent(new CustomEvent('transfer-tab-opened'));
  }
}

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
    btn.textContent = btn.dataset.originalText || btn.textContent;
    // Clear the saved text after restoring
    delete btn.dataset.originalText;
  }
}
