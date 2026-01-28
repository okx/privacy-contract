// App Entry Point
import { loadContractConfig, connectWallet, enablePrivacy, lookupMPK, walletState, setupProviderListeners, refreshBalances } from './wallet.js';
import { handleDeposit, handleWithdraw, handlePublicTransfer, handlePrivateTransfer, handlePublicToPublicTransfer, handlePublicToPrivateTransfer, handlePrivateToPublicTransfer } from './transactions.js';
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

  // Privacy enable button
  const privacyEnableBtn = document.getElementById('privacy-enable-btn');
  if (privacyEnableBtn) {
    privacyEnableBtn.addEventListener('click', async () => {
      // Prevent duplicate clicks
      if (walletState.isEnablingPrivacy || walletState.isPrivacyEnabled || !walletState.account) {
        return;
      }
      
      UI.setButtonLoading('#privacy-enable-btn', true, '开通中...');
      const success = await enablePrivacy();
      UI.setButtonLoading('#privacy-enable-btn', false);
      if (success) {
        UI.updateAll(walletState);
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
  
  // Single button to execute convert or approve
  if (convertActionBtn) {
    convertActionBtn.addEventListener('click', async () => {
      const action = convertActionBtn.dataset.action;
      const amount = convertAmountInput?.value || '';
      
      if (action === 'approve') {
        // Handle token approval
        UI.setButtonLoading('#convert-action-btn', true, '授权中...');
        const { approveToken } = await import('./wallet.js');
        const success = await approveToken();
        UI.setButtonLoading('#convert-action-btn', false);
        
        if (success) {
          // After approval, update button to show deposit
          await UI.updateConvertActionButton(convertDirection, walletState);
        }
      } else if (convertDirection === 'deposit') {
        handleDeposit(amount);
      } else {
        handleWithdraw(amount);
      }
    });
  }
  
  // Amount input change - check allowance for deposit
  if (convertAmountInput) {
    convertAmountInput.addEventListener('input', async () => {
      if (convertDirection === 'deposit') {
        const amount = convertAmountInput.value.trim();
        if (amount && parseFloat(amount) > 0) {
          await UI.updateConvertActionButton(convertDirection, walletState);
        } else {
          // Reset to default deposit button
          const btn = document.getElementById('convert-action-btn');
          if (btn) {
            btn.className = 'modal-single-action-btn deposit';
            btn.innerHTML = '<span class="btn-text">存入隐私</span><span class="btn-arrow">→</span>';
            btn.disabled = !walletState.account || !walletState.isPrivacyEnabled || parseFloat(walletState.publicBalance) <= 0;
            btn.dataset.action = 'deposit';
          }
        }
      }
    });
  }

  // Quick buttons (25%, 50%, 75%, Max) - use source balance
  document.querySelectorAll('.modal-quick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const percent = parseInt(btn.dataset.percent);
      // Use source balance based on current direction
      const balance = convertDirection === 'deposit' 
        ? parseFloat(walletState.publicBalance) || 0
        : parseFloat(walletState.privateBalance) || 0;
      const amount = (balance * percent / 100).toFixed(2);
      if (convertAmountInput) {
        convertAmountInput.value = amount;
        // Trigger input event to check allowance
        convertAmountInput.dispatchEvent(new Event('input'));
      }
      
      // Highlight selected button
      document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ========== Transfer - Balance Type Toggle ==========
  
  const transferAmountInput = document.getElementById('transfer-amount');
  const balanceToggleInput = document.getElementById('balance-toggle-input');
  
  // Toggle switch change (select balance type: public or private)
  if (balanceToggleInput) {
    balanceToggleInput.addEventListener('change', async (e) => {
      const balanceType = e.target.checked ? 'private' : 'public';
      UI.selectBalanceType(balanceType, walletState);
      
      // Clear input when switching balance type
      if (transferAmountInput) {
        transferAmountInput.value = '';
      }
      // Clear quick button highlight
      document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
      
      // Re-check recipient registration status and update transfer mode
      const transferAddress = document.getElementById('transfer-address');
      const address = transferAddress?.value?.trim();
      if (address && address.length === 42) {
        const ethersLib = ensureEthers();
        if (ethersLib.utils.isAddress(address)) {
          try {
            const userInfo = await lookupMPK(address);
            UI.updateTransferMode(balanceType, !!userInfo, walletState);
          } catch (err) {
            UI.updateTransferMode(balanceType, false, walletState);
          }
        }
      } else {
        UI.updateTransferMode(balanceType, null, walletState);
      }
    });
  }

  // ========== Transfer ==========
  
  // Transfer address input (check recipient registration status for all balance types)
  const transferAddress = document.getElementById('transfer-address');
  let lookupTimeout = null;
  
  if (transferAddress) {
    transferAddress.addEventListener('input', (e) => {
      const address = e.target.value.trim();
      const balanceType = UI.getBalanceType();
      
      if (lookupTimeout) {
        clearTimeout(lookupTimeout);
      }
      
      const ethersLib = ensureEthers();
      
      if (!address) {
        UI.updateTransferMode(balanceType, null, walletState);
        return;
      }
      
      if (!ethersLib.utils.isAddress(address)) {
        if (address.length >= 42) {
          UI.updateTransferMode(balanceType, false, walletState);
        } else {
          UI.updateTransferMode(balanceType, null, walletState);
        }
        return;
      }
      
      // Delayed MPK lookup (for all balance types)
      lookupTimeout = setTimeout(async () => {
        try {
          const userInfo = await lookupMPK(address);
          UI.updateTransferMode(balanceType, !!userInfo, walletState);
        } catch (err) {
          console.error('Lookup MPK error:', err);
          UI.updateTransferMode(balanceType, false, walletState);
        }
      }, 500);
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

  // Privacy account checkbox change listener
  const privacyCheckbox = document.getElementById('send-to-privacy-checkbox');
  if (privacyCheckbox) {
    privacyCheckbox.addEventListener('change', () => {
      const balanceType = UI.getBalanceType();
      const transferAddress = document.getElementById('transfer-address');
      const address = transferAddress?.value?.trim() || '';
      
      // Re-check recipient registration and update mode
      if (address) {
        const ethersLib = ensureEthers();
        if (ethersLib.utils.isAddress(address)) {
          (async () => {
            try {
              const userInfo = await lookupMPK(address);
              UI.updateTransferMode(balanceType, !!userInfo, walletState);
            } catch (err) {
              console.error('Lookup MPK error:', err);
              UI.updateTransferMode(balanceType, false, walletState);
            }
          })();
        }
      }
    });
  }

  // Transfer submit button
  const transferBtn = document.getElementById('transfer-btn');
  if (transferBtn) {
    transferBtn.addEventListener('click', async () => {
      const transferAddressInput = document.getElementById('transfer-address');
      const transferAmountInput = document.getElementById('transfer-amount');
      const address = transferAddressInput?.value?.trim() || '';
      const amount = transferAmountInput?.value || '';
      const mode = UI.getTransferMode();
      const balanceType = UI.getBalanceType();
      const sendToPrivacy = UI.getSendToPrivacyAccount();
      
      // Check recipient registration status
      let recipientRegistered = false;
      if (address) {
        const ethersLib = ensureEthers();
        if (ethersLib.utils.isAddress(address)) {
          try {
            const userInfo = await lookupMPK(address);
            recipientRegistered = !!userInfo;
          } catch (err) {
            console.error('Lookup MPK error:', err);
            recipientRegistered = false;
          }
        }
      }
      
      // Determine final mode based on balance type, recipient status, and user choice
      let finalMode = mode;
      if (balanceType === 'public') {
        if (recipientRegistered && sendToPrivacy) {
          finalMode = 'public-to-private';
        } else {
          finalMode = 'public-to-public';
        }
      } else {
        if (recipientRegistered && sendToPrivacy) {
          finalMode = 'private-to-private';
        } else {
          finalMode = 'private-to-public';
        }
      }
      
      // Route to appropriate handler based on final mode
      if (finalMode === 'public-to-public') {
        handlePublicToPublicTransfer(address, amount);
      } else if (finalMode === 'public-to-private') {
        handlePublicToPrivateTransfer(address, amount);
      } else if (finalMode === 'private-to-private') {
        handlePrivateTransfer(address, amount);
      } else if (finalMode === 'private-to-public') {
        handlePrivateToPublicTransfer(address, amount);
      } else {
        // Fallback to old logic
        if (balanceType === 'public') {
          handlePublicTransfer(address, amount);
        } else {
          handlePrivateTransfer(address, amount);
        }
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
