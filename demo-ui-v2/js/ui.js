// UI Update Module
import { formatAddress, formatBalance, getTimeAgo } from './utils.js';
import { erc20TokenInfo, CONFIG } from './config.js';

// DOM Cache
const dom = {
  connectBtn: () => document.getElementById('connect-btn'),
  accountAddress: () => document.getElementById('account-address'),
  privacyToggle: () => document.getElementById('privacy-toggle'),
  privacyStatus: () => document.getElementById('privacy-status'),
  tokenInfo: () => document.getElementById('token-info'),
  tokenSymbolBadge: () => document.getElementById('token-symbol-badge'),
  publicBalance: () => document.getElementById('public-balance'),
  privateBalance: () => document.getElementById('private-balance'),
  historyList: () => document.getElementById('history-list'),
  
  // Balance Convert (Modal single button)
  convertModal: () => document.getElementById('convert-modal'),
  convertActionBtn: () => document.getElementById('convert-action-btn'),
  convertAmount: () => document.getElementById('convert-amount'),
  
  // Transfer - Toggle Switch
  balanceToggleInput: () => document.getElementById('balance-toggle-input'),
  toggleCurrentBalance: () => document.getElementById('toggle-current-balance'),
  
  // Transfer
  transferAddress: () => document.getElementById('transfer-address'),
  transferAmount: () => document.getElementById('transfer-amount'),
  transferSuffix: () => document.getElementById('transfer-suffix'),
  transferBtn: () => document.getElementById('transfer-btn'),
  transferRecipientStatus: () => document.getElementById('transfer-recipient-status'),
  transferHint: () => document.getElementById('transfer-hint'),
  
  // Transaction Details
  transactionDetailsCard: () => document.getElementById('transaction-details-card'),
  transactionDetailsContent: () => document.getElementById('transaction-details-content'),
};

// Current State
let currentTransferType = 'public'; // 'public' or 'private'

// Update Connect Button
export function updateConnectButton(state) {
  const btn = dom.connectBtn();
  if (!btn) return;
  
  if (state.account) {
    btn.textContent = formatAddress(state.account) + ' ▾';
    btn.classList.add('connected');
  } else {
    btn.textContent = '连接钱包';
    btn.classList.remove('connected');
  }
}

// Update Account Info
export function updateAccountInfo(state) {
  const addressEl = dom.accountAddress();
  if (addressEl) {
    addressEl.textContent = state.account || '未连接';
  }
  
  // Update privacy toggle
  const toggle = dom.privacyToggle();
  const statusEl = dom.privacyStatus();
  
  if (toggle) {
    toggle.disabled = !state.account;
    toggle.checked = state.isPrivacyEnabled;
  }
  
  if (statusEl) {
    statusEl.classList.remove('enabled', 'disabled');
    const statusText = statusEl.querySelector('.status-text');
    
    if (!state.account) {
      statusText.textContent = '请先连接钱包';
    } else if (state.isPrivacyEnabled) {
      statusEl.classList.add('enabled');
      statusText.textContent = '✓ 已启用隐私保护';
    } else {
      statusEl.classList.add('disabled');
      statusText.textContent = '未启用（点击开关启用）';
    }
  }
}

// Update Balances
export function updateBalances(state) {
  const publicEl = dom.publicBalance();
  const privateEl = dom.privateBalance();
  const symbol = erc20TokenInfo.symbol;
  
  // Public balance
  if (publicEl) {
    publicEl.textContent = formatBalance(state.publicBalance);
  }
  
  // Private balance
  if (privateEl) {
    privateEl.textContent = formatBalance(state.privateBalance);
  }
  
  // Update privacy visibility based on state
  updatePrivacyVisibility(state);
  
  // Update convert buttons state
  updateConvertButtons(state);
  
  // Update toggle balance display
  updateToggleBalance(state);
  
  // Update transfer button state
  updateTransferButtonState(state);
}

// Update privacy visibility based on enabled state
function updatePrivacyVisibility(state) {
  const privateBalanceRow = document.getElementById('private-balance-row');
  const convertBtn = document.getElementById('open-convert-modal');
  const balanceStaticDisplay = document.getElementById('balance-static-display');
  const balanceToggleWrapper = document.getElementById('balance-toggle-wrapper');
  const staticPublicBalance = document.getElementById('static-public-balance');
  
  const isPrivacyEnabled = state.isPrivacyEnabled;
  
  // Private balance row
  if (privateBalanceRow) {
    privateBalanceRow.style.display = isPrivacyEnabled ? 'flex' : 'none';
  }
  
  // Privacy convert button
  if (convertBtn) {
    convertBtn.style.display = isPrivacyEnabled ? 'block' : 'none';
  }
  
  // Transfer area: static display vs toggle switch
  if (balanceStaticDisplay) {
    balanceStaticDisplay.style.display = isPrivacyEnabled ? 'none' : 'flex';
  }
  if (balanceToggleWrapper) {
    balanceToggleWrapper.style.display = isPrivacyEnabled ? 'block' : 'none';
  }
  
  // Update static balance display (with type label)
  if (staticPublicBalance) {
    staticPublicBalance.textContent = `可用余额: ${formatBalance(state.publicBalance)} ${erc20TokenInfo.symbol}（公开）`;
  }
  
  // Update toggle balance display
  updateToggleBalance(state);
}

// Update convert buttons state (single button design)
function updateConvertButtons(state) {
  // Single button state is handled in updateConvertActionButton
  // Here we only update the modal trigger button
  const openModalBtn = document.getElementById('open-convert-modal');
  if (openModalBtn) {
    openModalBtn.disabled = !state.account || !state.isPrivacyEnabled;
  }
}

// Update Modal balance display (supports direction switch)
export function updateModalBalances(state, direction = 'deposit') {
  const fromIcon = document.getElementById('modal-from-icon');
  const fromLabel = document.getElementById('modal-from-label');
  const fromValue = document.getElementById('modal-from-value');
  const toIcon = document.getElementById('modal-to-icon');
  const toLabel = document.getElementById('modal-to-label');
  const toValue = document.getElementById('modal-to-value');
  const modalTokenSymbol = document.getElementById('modal-token-symbol');
  
  if (direction === 'deposit') {
    // Public → Private
    if (fromIcon) fromIcon.textContent = '💳';
    if (fromLabel) fromLabel.textContent = '公开余额';
    if (fromValue) fromValue.textContent = formatBalance(state.publicBalance);
    if (toIcon) toIcon.textContent = '🔐';
    if (toLabel) toLabel.textContent = '隐私余额';
    if (toValue) toValue.textContent = formatBalance(state.privateBalance);
  } else {
    // Private → Public
    if (fromIcon) fromIcon.textContent = '🔐';
    if (fromLabel) fromLabel.textContent = '隐私余额';
    if (fromValue) fromValue.textContent = formatBalance(state.privateBalance);
    if (toIcon) toIcon.textContent = '💳';
    if (toLabel) toLabel.textContent = '公开余额';
    if (toValue) toValue.textContent = formatBalance(state.publicBalance);
  }
  
  if (modalTokenSymbol) {
    modalTokenSymbol.textContent = erc20TokenInfo.symbol;
  }
}

// Update convert action button
export function updateConvertActionButton(direction, state) {
  const btn = document.getElementById('convert-action-btn');
  if (!btn) {
    console.warn('convert-action-btn not found');
    return;
  }
  
  if (direction === 'deposit') {
    // Deposit to private (Public → Private)
    btn.className = 'modal-single-action-btn deposit';
    btn.innerHTML = '<span class="btn-text">存入隐私</span><span class="btn-arrow">→</span>';
    btn.disabled = !state.account || !state.isPrivacyEnabled || parseFloat(state.publicBalance) <= 0;
  } else {
    // Withdraw to public (Private → Public)
    btn.className = 'modal-single-action-btn withdraw';
    btn.innerHTML = '<span class="btn-text">提取公开</span><span class="btn-arrow">←</span>';
    btn.disabled = !state.account || !state.isPrivacyEnabled || parseFloat(state.privateBalance) <= 0;
  }
}

// Update Token Display
export function updateTokenDisplay() {
  const tokenInfoEl = dom.tokenInfo();
  const tokenBadgeEl = dom.tokenSymbolBadge();
  const symbol = erc20TokenInfo.symbol;
  
  // Update token info
  if (tokenInfoEl && erc20TokenInfo.address) {
    tokenInfoEl.innerHTML = `
      <strong style="color: var(--text-primary);">${symbol}</strong>
      <span style="margin-left: 8px;">${erc20TokenInfo.name}</span>
      <span style="margin-left: 8px; font-family: monospace; font-size: 10px;">${formatAddress(erc20TokenInfo.address)}</span>
    `;
  }
  
  // Update token badge
  if (tokenBadgeEl) {
    tokenBadgeEl.textContent = symbol;
  }
  
  // Update transfer input suffix
  const transferSuffix = dom.transferSuffix();
  if (transferSuffix) transferSuffix.textContent = symbol;
}

// Update toggle balance display
function updateToggleBalance(state) {
  const toggleBalanceEl = document.getElementById('toggle-current-balance');
  const symbol = erc20TokenInfo.symbol;
  
  if (!toggleBalanceEl) return;
  
  // Show balance based on selected type (with type label)
  if (currentTransferType === 'public') {
    toggleBalanceEl.textContent = `可用余额: ${formatBalance(state.publicBalance)} ${symbol}（公开）`;
    toggleBalanceEl.classList.remove('private');
  } else {
    toggleBalanceEl.textContent = `可用余额: ${formatBalance(state.privateBalance)} ${symbol}（隐私）`;
    toggleBalanceEl.classList.add('private');
  }
}

// Update History
export function updateHistory(transactions) {
  const listEl = dom.historyList();
  if (!listEl) return;

  if (transactions.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>暂无交易记录</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = transactions.slice(0, 5).map((tx, index) => {
    const statusIcon = tx.status === 'success' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
    return `
      <div class="history-item" data-tx-index="${index}">
        <div class="history-icon ${tx.type}">${tx.icon}</div>
        <div class="history-info">
          <h4>${tx.title} ${statusIcon}</h4>
          <p>${tx.description}</p>
        </div>
        <div class="history-amount">
          <div class="value">${tx.amount}</div>
          <div class="time">${getTimeAgo(tx.timestamp)}</div>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click event
  listEl.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.txIndex);
      showTransactionDetails(transactions[index]);
    });
  });
}

// Show Transaction Details
export function showTransactionDetails(tx) {
  const card = dom.transactionDetailsCard();
  const content = dom.transactionDetailsContent();
  if (!card || !content) return;
  
  const statusIcon = tx.status === 'success' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
  const statusText = tx.status === 'success' ? '成功' : tx.status === 'pending' ? '等待中' : '失败';
  
  content.innerHTML = `
    <button class="back-btn" id="back-to-list">← 返回</button>
    
    <div class="tx-detail-row">
      <span class="tx-detail-label">类型</span>
      <span class="tx-detail-value">${tx.icon} ${tx.title}</span>
    </div>
    
    <div class="tx-detail-row">
      <span class="tx-detail-label">金额</span>
      <span class="tx-detail-value">${tx.amount}</span>
    </div>
    
    <div class="tx-detail-row">
      <span class="tx-detail-label">状态</span>
      <span class="tx-detail-value">${statusIcon} ${statusText}</span>
    </div>
    
    <div class="tx-detail-row">
      <span class="tx-detail-label">时间</span>
      <span class="tx-detail-value">${new Date(tx.timestamp).toLocaleString('zh-CN')} (${getTimeAgo(tx.timestamp)})</span>
    </div>
    
    ${tx.txHash ? `
      <div class="tx-detail-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
        <span class="tx-detail-label">交易哈希</span>
        <span class="tx-detail-value tx-hash">${tx.txHash}</span>
        ${CONFIG.TARGET_CHAIN.blockExplorerUrl ? `
          <a href="${CONFIG.TARGET_CHAIN.blockExplorerUrl}/tx/${tx.txHash}" target="_blank" style="color: var(--accent-blue); font-size: 12px;">在区块浏览器中查看 →</a>
        ` : ''}
      </div>
    ` : ''}
  `;
  
  card.style.display = 'block';
  
  // Back button
  const backBtn = document.getElementById('back-to-list');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      card.style.display = 'none';
    });
  }
}

// Update Transfer Recipient Status
export function updateTransferRecipientStatus(status, message) {
  const statusEl = dom.transferRecipientStatus();
  const hintEl = dom.transferHint();
  if (!statusEl) return;
  
  // Set status style
  statusEl.className = 'recipient-status';
  statusEl.classList.add(status);
  statusEl.textContent = message;
  
  // Show status, hide default hint
  if (status && message) {
    statusEl.style.display = 'inline';
    if (hintEl) hintEl.style.display = 'none';
  } else {
    statusEl.style.display = 'none';
    if (hintEl) hintEl.style.display = 'inline';
  }
}

// Set Button Loading State
export function setButtonLoading(selector, isLoading, loadingText = '处理中...') {
  const btn = document.querySelector(selector);
  if (!btn) return;
  
  if (isLoading) {
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
    delete btn.dataset.originalText;
  }
}

// Select Transfer Type
export function selectTransferType(type, state) {
  currentTransferType = type;
  
  const transferBtn = dom.transferBtn();
  const hintEl = dom.transferHint();
  const statusEl = dom.transferRecipientStatus();
  const toggleInput = document.getElementById('balance-toggle-input');
  
  // Update toggle switch state
  if (toggleInput) {
    toggleInput.checked = (type === 'private');
  }
  
  // Update balance display
  updateToggleBalance(state);
  
  // Update transfer button
  if (transferBtn) {
    if (type === 'public') {
      transferBtn.textContent = '💳 发送公开转账';
      transferBtn.className = 'submit-btn transfer-public';
    } else {
      transferBtn.textContent = '🔐 发送隐私转账';
      transferBtn.className = 'submit-btn transfer-private';
    }
  }
  
  // Reset status display when switching to public
  if (type === 'public') {
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.className = 'recipient-status';
    }
    if (hintEl) {
      hintEl.style.display = 'inline';
      hintEl.textContent = '输入对方钱包地址';
    }
  }
  
  // Update hint (show requirement for private transfer)
  if (hintEl && type === 'private') {
    hintEl.textContent = '对方需已启用隐私交易';
  }
  
  // Update button state
  updateTransferButtonState(state);
}

// Update Transfer Button State
function updateTransferButtonState(state) {
  const transferBtn = dom.transferBtn();
  if (!transferBtn) return;
  
  // Wallet must be connected
  if (!state.account) {
    transferBtn.disabled = true;
    return;
  }
  
  // Private transfer requires privacy enabled
  if (currentTransferType === 'private' && !state.isPrivacyEnabled) {
    transferBtn.disabled = true;
    return;
  }
  
  transferBtn.disabled = false;
}

// Get Current Transfer Type
export function getTransferType() {
  return currentTransferType;
}

// Get Current Balance (based on selected type)
export function getCurrentBalance(state) {
  if (currentTransferType === 'public') {
    return state.publicBalance;
  }
  return state.privateBalance;
}

// Update All UI
export function updateAll(state) {
  updateConnectButton(state);
  updateAccountInfo(state);
  updateBalances(state);
  updateTokenDisplay();
}
