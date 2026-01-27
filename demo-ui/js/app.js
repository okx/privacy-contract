// Main Application Entry Point
import { loadContractConfig, connectWallet, registerMPK, setupProviderListeners, handleTransferLookup, walletState, refreshBalances } from './wallet.js';
import { handleShield, handleUnshield, handleTransfer, handleERC20Transfer } from './transactions.js';
import * as UI from './ui.js';
import { waitForLibrary, debounce, copyToClipboard } from './utils.js';

class PrivacyWalletApp {
  constructor() {
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    console.log('🚀 Initializing Privacy Wallet App...');
    console.log('Current time:', new Date().toLocaleString());

    try {
      // Load contract configuration
      await loadContractConfig();

      // Wait for ethers.js to load
      await waitForLibrary('ethers', 5000);
      console.log('✅ ethers.js loaded');

      // Initialize UI
      UI.domCache.init();
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Setup provider listeners for account/chain changes
      setupProviderListeners();

      this.initialized = true;
      console.log('✅ App initialized successfully');
      console.log('👉 Click "Connect Wallet" to start');

    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
    }
  }

  setupEventListeners() {
    // Connect button
    const connectBtn = document.getElementById('connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => connectWallet());
    }

    // Privacy mode toggle
    const privacyToggle = document.getElementById('privacy-mode-toggle');
    if (privacyToggle) {
      privacyToggle.addEventListener('change', (e) => {
        this.handlePrivacyModeToggle(e.target.checked);
      });
    }

    // Shield/Unshield sidebar buttons
    const sidebarShieldBtn = document.getElementById('sidebar-shield-btn');
    const sidebarUnshieldBtn = document.getElementById('sidebar-unshield-btn');
    
    if (sidebarShieldBtn) {
      sidebarShieldBtn.addEventListener('click', () => this.openModal('shield'));
    }
    
    if (sidebarUnshieldBtn) {
      sidebarUnshieldBtn.addEventListener('click', () => this.openModal('unshield'));
    }

    // Modal close buttons
    const shieldModalClose = document.getElementById('shield-modal-close');
    const unshieldModalClose = document.getElementById('unshield-modal-close');
    
    if (shieldModalClose) {
      shieldModalClose.addEventListener('click', () => this.closeModal('shield'));
    }
    
    if (unshieldModalClose) {
      unshieldModalClose.addEventListener('click', () => this.closeModal('unshield'));
    }

    // Close modal when clicking outside
    document.getElementById('shield-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'shield-modal') {
        this.closeModal('shield');
      }
    });
    
    document.getElementById('unshield-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'unshield-modal') {
        this.closeModal('unshield');
      }
    });

    // Submit buttons
    const erc20TransferBtn = document.getElementById('erc20-transfer-btn');
    const privateTransferBtn = document.getElementById('private-transfer-btn');
    const shieldBtn = document.getElementById('shield-btn');
    const unshieldBtn = document.getElementById('unshield-btn');
    
    if (erc20TransferBtn) {
      erc20TransferBtn.addEventListener('click', () => {
        const recipientInput = document.getElementById('erc20-recipient');
        const amountInput = document.getElementById('erc20-amount');
        handleERC20Transfer(recipientInput.value.trim(), amountInput.value.trim());
      });
    }

    if (privateTransferBtn) {
      privateTransferBtn.addEventListener('click', () => {
        const recipientInput = document.getElementById('private-recipient');
        const amountInput = document.getElementById('private-amount');
        handleTransfer(recipientInput.value.trim(), amountInput.value.trim());
      });
    }

    if (shieldBtn) {
      shieldBtn.addEventListener('click', () => {
        const amountInput = document.getElementById('shield-amount');
        handleShield(amountInput.value.trim());
      });
    }

    if (unshieldBtn) {
      unshieldBtn.addEventListener('click', () => {
        const amountInput = document.getElementById('unshield-amount');
        handleUnshield(amountInput.value.trim());
      });
    }

    // MAX buttons
    document.querySelectorAll('.max-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.target.dataset.mode;
        
        if (mode === 'erc20') {
          const amountInput = document.getElementById('erc20-amount');
          amountInput.value = walletState.publicBalance;
        } else if (mode === 'private') {
          const amountInput = document.getElementById('private-amount');
          amountInput.value = walletState.privateBalance;
        } else if (mode === 'shield') {
          const amountInput = document.getElementById('shield-amount');
          amountInput.value = walletState.publicBalance;
        } else if (mode === 'unshield') {
          const amountInput = document.getElementById('unshield-amount');
          amountInput.value = walletState.privateBalance;
        }
      });
    });

    // Private transfer address input with debounced lookup
    const privateRecipientInput = document.getElementById('private-recipient');
    if (privateRecipientInput) {
      const debouncedLookup = debounce((address) => {
        if (!address) {
          handleTransferLookup(null);
          return;
        }
        
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          return;
        }
        
        handleTransferLookup(address);
      }, 500);

      privateRecipientInput.addEventListener('input', (e) => {
        debouncedLookup(e.target.value.trim());
      });
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabText = e.target.textContent;
        let tabName = 'transfer';
        if (tabText.includes('💸')) tabName = 'transfer';
        else if (tabText.includes('📋')) tabName = 'transactions';
        
        UI.switchTab(tabName);
      });
    });

    // Custom events
    window.addEventListener('register-mpk', () => registerMPK());
    
    window.addEventListener('show-transaction', (e) => {
      const tx = walletState.transactions[e.detail.index];
      if (tx) {
        UI.switchTab('transactions');
        UI.showTransactionDetails(tx, walletState.chainId);
      }
    });

    window.addEventListener('show-transaction-list', () => {
      UI.showTransactionList(walletState.transactions);
    });

    window.addEventListener('copy-to-clipboard', async (e) => {
      const success = await copyToClipboard(e.detail.text);
      if (success) {
        console.log('Copied to clipboard');
      } else {
        console.error('Failed to copy to clipboard');
      }
    });

    // Handle transfer tab opened event
    window.addEventListener('transfer-tab-opened', () => {
      const privateRecipientInput = document.getElementById('private-recipient');
      if (privateRecipientInput) {
        const address = privateRecipientInput.value.trim();
        if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
          handleTransferLookup(address);
        }
      }
    });

    // Refresh balances periodically (every 30 seconds)
    setInterval(() => {
      if (walletState.account && walletState.provider) {
        refreshBalances();
      }
    }, 30000);
  }

  handlePrivacyModeToggle(isEnabled) {
    const erc20Form = document.getElementById('erc20-transfer-form');
    const privateForm = document.getElementById('private-transfer-form');
    const privacyStatus = document.getElementById('privacy-status');
    
    if (isEnabled) {
      // Switch to private mode
      erc20Form.style.display = 'none';
      privateForm.style.display = 'block';
      
      // Update status display
      if (privacyStatus) {
        const statusDot = privacyStatus.querySelector('.status-dot');
        const statusText = privacyStatus.querySelector('.status-text');
        
        if (walletState.isRegistered) {
          statusDot.classList.remove('unregistered');
          statusDot.classList.add('registered');
          statusText.textContent = 'Privacy activated';
        } else {
          statusDot.classList.remove('registered');
          statusDot.classList.add('unregistered');
          statusText.textContent = 'Activating...';
        }
      }
      
      // Check if user needs to register
      if (walletState.account && !walletState.isRegistered) {
        console.log('Privacy mode enabled, but MPK not registered. Prompting registration...');
        // Trigger registration flow
        window.dispatchEvent(new CustomEvent('register-mpk'));
      }
    } else {
      // Switch to ERC20 mode
      erc20Form.style.display = 'block';
      privateForm.style.display = 'none';
      
      // Update status display
      if (privacyStatus) {
        const statusDot = privacyStatus.querySelector('.status-dot');
        const statusText = privacyStatus.querySelector('.status-text');
        statusDot.classList.remove('registered');
        statusDot.classList.add('unregistered');
        statusText.textContent = 'Privacy disabled';
      }
    }
  }

  openModal(type) {
    const modal = document.getElementById(`${type}-modal`);
    if (modal) {
      modal.classList.add('active');
    }
  }

  closeModal(type) {
    const modal = document.getElementById(`${type}-modal`);
    if (modal) {
      modal.classList.remove('active');
    }
  }
}

// Initialize app when DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const app = new PrivacyWalletApp();
  await app.init();
});

// Make switchTab globally available for HTML onclick handlers
window.switchTab = UI.switchTab;
