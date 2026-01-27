// App Entry Point
import { loadContractConfig, connectWallet, enablePrivacy, lookupMPK, walletState, setupProviderListeners, refreshBalances } from './wallet.js';
import { handleDeposit, handleWithdraw, handlePublicTransfer, handlePrivateTransfer } from './transactions.js';
import * as UI from './ui.js';
import { ensureEthers, showToast } from './utils.js';

// Initialize App
async function init() {
  console.log('🔒 Privacy Wallet v2 initializing...');
  
  // Load config
  await loadContractConfig();
  
  // Setup provider listeners
  setupProviderListeners();
  
  // Bind events
  bindEvents();
  
  // Initialize UI
  UI.updateAll(walletState);
  
  console.log('✅ App initialization complete');
}

// Bind All Events
function bindEvents() {
  // Connect wallet button
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      if (walletState.account) {
        showToast('info', '已连接', `当前地址: ${walletState.account}`);
      } else {
        connectWallet();
      }
    });
  }

  // Privacy toggle
  const privacyToggle = document.getElementById('privacy-toggle');
  if (privacyToggle) {
    privacyToggle.addEventListener('change', async (e) => {
      if (e.target.checked && !walletState.isPrivacyEnabled) {
        const success = await enablePrivacy();
        if (!success) {
          e.target.checked = false;
        }
      } else if (!e.target.checked && walletState.isPrivacyEnabled) {
        e.target.checked = true;
        showToast('info', '无法禁用', '隐私交易一旦启用无法禁用');
      }
    });
  }

  // ========== Balance Convert (Modal + Single Button Design) ==========
  
  const convertModal = document.getElementById('convert-modal');
  const openModalBtn = document.getElementById('open-convert-modal');
  const closeModalBtn = document.getElementById('close-convert-modal');
  const convertAmountInput = document.getElementById('convert-amount');
  const swapDirectionBtn = document.getElementById('modal-swap-direction');
  const convertActionBtn = document.getElementById('convert-action-btn');
  
  // Convert direction state: 'deposit' (Public→Private) or 'withdraw' (Private→Public)
  let convertDirection = 'deposit';
  
  // Open Modal
  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => {
      if (convertModal) {
        convertModal.style.display = 'flex';
        convertDirection = 'deposit'; // Reset to default direction
        
        // Clear input
        if (convertAmountInput) {
          convertAmountInput.value = '';
        }
        // Clear quick button highlight
        document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
        
        UI.updateModalBalances(walletState, convertDirection);
        UI.updateConvertActionButton(convertDirection, walletState);
      }
    });
  }
  
  // Close Modal (only via X button)
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
      if (convertModal) {
        convertModal.style.display = 'none';
      }
    });
  }
  
  // Click arrow to swap direction
  if (swapDirectionBtn) {
    swapDirectionBtn.addEventListener('click', () => {
      // Toggle direction
      convertDirection = convertDirection === 'deposit' ? 'withdraw' : 'deposit';
      
      // Update UI (bidirectional arrow doesn't need rotation)
      UI.updateModalBalances(walletState, convertDirection);
      UI.updateConvertActionButton(convertDirection, walletState);
      
      // Clear quick button highlight
      document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
    });
  }
  
  // Single button to execute convert
  if (convertActionBtn) {
    convertActionBtn.addEventListener('click', () => {
      const amount = convertAmountInput?.value || '';
      if (convertDirection === 'deposit') {
        handleDeposit(amount);
      } else {
        handleWithdraw(amount);
      }
    });
  }
  
  // Quick buttons (25%, 50%, 75%, Max) - use source balance
  document.querySelectorAll('.modal-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const percent = parseInt(btn.dataset.percent);
      // Use source balance based on current direction
      const balance = convertDirection === 'deposit' 
        ? parseFloat(walletState.publicBalance) || 0
        : parseFloat(walletState.privateBalance) || 0;
      const amount = (balance * percent / 100).toFixed(2);
      if (convertAmountInput) {
        convertAmountInput.value = amount;
      }
      
      // Highlight selected button
      document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ========== Transfer - Toggle Switch ==========
  
  const transferAmountInput = document.getElementById('transfer-amount');
  const balanceToggleInput = document.getElementById('balance-toggle-input');
  
  // Toggle switch change
  if (balanceToggleInput) {
    balanceToggleInput.addEventListener('change', async (e) => {
      const type = e.target.checked ? 'private' : 'public';
      UI.selectTransferType(type, walletState);
      
      // Clear input when switching balance type
      if (transferAmountInput) {
        transferAmountInput.value = '';
      }
      // Clear quick button highlight
      document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
      
      // Auto-check MPK when switching to private transfer if address exists
      if (type === 'private') {
        const transferAddress = document.getElementById('transfer-address');
        const address = transferAddress?.value?.trim();
        if (address && address.length === 42) {
          UI.updateTransferRecipientStatus('checking', '检查中...');
          try {
            const userInfo = await lookupMPK(address);
            if (userInfo) {
              UI.updateTransferRecipientStatus('found', '已启用隐私交易');
            } else {
              UI.updateTransferRecipientStatus('not-found', '未启用隐私交易');
            }
          } catch (err) {
            UI.updateTransferRecipientStatus('not-found', '查询失败');
          }
        }
      }
    });
  }

  // ========== Transfer ==========
  
  // Transfer address input (lookup MPK for private transfer)
  const transferAddress = document.getElementById('transfer-address');
  let lookupTimeout = null;
  
  if (transferAddress) {
    transferAddress.addEventListener('input', (e) => {
      const address = e.target.value.trim();
      
      if (lookupTimeout) {
        clearTimeout(lookupTimeout);
      }
      
      // Delayed MPK lookup for private transfer
      if (UI.getTransferType() === 'private') {
        const ethersLib = ensureEthers();
        
        if (!address) {
          UI.updateTransferRecipientStatus(null, '等待输入地址...');
          return;
        }
        
        if (!ethersLib.utils.isAddress(address)) {
          if (address.length >= 42) {
            UI.updateTransferRecipientStatus('not-found', '地址格式无效');
          }
          return;
        }
        
        UI.updateTransferRecipientStatus(null, '查询中...');
        
        lookupTimeout = setTimeout(async () => {
          const userInfo = await lookupMPK(address);
          if (userInfo) {
            UI.updateTransferRecipientStatus('found', '已启用隐私交易');
          } else {
            UI.updateTransferRecipientStatus('not-found', '未启用隐私交易');
          }
        }, 500);
      }
    });
  }

  // Transfer quick percentage buttons
  document.querySelectorAll('.transfer-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const percent = parseInt(btn.dataset.percent);
      const currentBalance = parseFloat(UI.getCurrentBalance(walletState)) || 0;
      const amount = (currentBalance * percent / 100).toFixed(2);
      
      const transferAmountInput = document.getElementById('transfer-amount');
      if (transferAmountInput) {
        transferAmountInput.value = amount;
      }
      
      // Update highlight state
      document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Transfer submit button
  const transferBtn = document.getElementById('transfer-btn');
  if (transferBtn) {
    transferBtn.addEventListener('click', () => {
      const transferAddressInput = document.getElementById('transfer-address');
      const transferAmountInput = document.getElementById('transfer-amount');
      const address = transferAddressInput?.value?.trim() || '';
      const amount = transferAmountInput?.value || '';
      const transferType = UI.getTransferType();
      
      if (transferType === 'public') {
        handlePublicTransfer(address, amount);
      } else {
        handlePrivateTransfer(address, amount);
      }
    });
  }

  // Periodically refresh balances
  setInterval(() => {
    if (walletState.account) {
      refreshBalances();
    }
  }, 30000);
}

// Initialize after DOM loaded
document.addEventListener('DOMContentLoaded', init);
