// Main Application Entry Point
import { loadContractConfig, connectWallet, registerMPK, setupProviderListeners, handleTransferLookup, walletState, refreshBalances } from './wallet.js';
import { handleShield, handleUnshield, handleTransfer } from './transactions.js';
import * as UI from './ui.js';
import { waitForLibrary, debounce, copyToClipboard } from './utils.js';
import { toast } from '../components/toast.js';

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
      console.log('👉 Click "Connect MetaMask" to start');

    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
      // toast.error('Failed to initialize application. Please refresh the page.', 'Initialization Error');
    }
  }

  setupEventListeners() {
    // Connect button
    const connectBtn = document.getElementById('connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => connectWallet());
    }

    // Submit buttons
    const shieldBtn = document.querySelector('#shield-panel .submit-btn');
    const unshieldBtn = document.querySelector('#unshield-panel .submit-btn');
    const transferBtn = document.querySelector('#transfer-panel .submit-btn');
    
    if (shieldBtn) {
      shieldBtn.addEventListener('click', () => {
        const amountInput = document.querySelector('#shield-panel .form-input');
        handleShield(amountInput.value.trim());
      });
    }

    if (unshieldBtn) {
      unshieldBtn.addEventListener('click', () => {
        const amountInput = document.querySelector('#unshield-panel .form-input');
        handleUnshield(amountInput.value.trim());
      });
    }

    if (transferBtn) {
      transferBtn.addEventListener('click', () => {
        const recipientInput = document.querySelector('#transfer-panel .form-input');
        const amountInput = document.querySelectorAll('#transfer-panel .form-input')[1];
        handleTransfer(recipientInput.value.trim(), amountInput.value.trim());
      });
    }

    // MAX buttons
    document.querySelectorAll('.max-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const panel = e.target.closest('.panel-content');
        
        let amountInput;
        if (panel.id === 'shield-panel' || panel.id === 'unshield-panel') {
          amountInput = panel.querySelector('.form-input');
        } else {
          amountInput = panel.querySelectorAll('.form-input')[1];
        }
        
        if (panel.id === 'shield-panel') {
          amountInput.value = walletState.publicBalance;
        } else {
          amountInput.value = walletState.privateBalance;
        }
      });
    });

    // Transfer address input with debounced lookup
    const transferAddressInput = document.querySelector('#transfer-panel .form-input');
    if (transferAddressInput) {
      const debouncedLookup = debounce((address) => {
        // Only lookup if address is not empty and looks like valid format
        if (!address) {
          handleTransferLookup(null);
          return;
        }
        
        // Basic format check (0x + 40 hex chars)
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          // Invalid format, don't trigger lookup yet (user might still typing)
          return;
        }
        
        handleTransferLookup(address);
      }, 500);

      transferAddressInput.addEventListener('input', (e) => {
        debouncedLookup(e.target.value.trim());
      });
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabText = e.target.textContent;
        let tabName = 'shield';
        if (tabText.includes('📤')) tabName = 'unshield';
        else if (tabText.includes('🔄')) tabName = 'transfer';
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
        // toast.success('Copied to clipboard!', 'Copied');
        console.log('Copied to clipboard');
      } else {
        // toast.error('Failed to copy to clipboard', 'Copy Failed');
        console.error('Failed to copy to clipboard');
      }
    });

    // Handle transfer tab opened event
    window.addEventListener('transfer-tab-opened', () => {
      const transferAddressInput = document.querySelector('#transfer-panel .form-input');
      if (transferAddressInput) {
        const address = transferAddressInput.value.trim();
        // Only lookup if address exists and has valid format
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
}

// Initialize app when DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const app = new PrivacyWalletApp();
  await app.init();
});

// Make switchTab globally available for HTML onclick handlers
window.switchTab = UI.switchTab;
