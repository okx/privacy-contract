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

    // Convert mode toggle
    this.convertMode = 'shield'; // Default mode
    const convertSwitchBtn = document.getElementById('convert-switch-btn');
    
    if (convertSwitchBtn) {
      convertSwitchBtn.addEventListener('click', () => this.toggleConvertMode());
    }

    // Convert action button
    const convertActionBtn = document.getElementById('convert-action-btn');
    if (convertActionBtn) {
      convertActionBtn.addEventListener('click', () => {
        const amountInput = document.getElementById('convert-amount');
        if (this.convertMode === 'shield') {
          handleShield(amountInput.value.trim());
        } else {
          handleUnshield(amountInput.value.trim());
        }
      });
    }

    // Convert quick buttons (RANDOM and MAX)
    const convertRandomBtn = document.getElementById('convert-random-btn');
    const convertMaxBtn = document.getElementById('convert-max-btn');
    
    if (convertRandomBtn) {
      convertRandomBtn.addEventListener('click', () => {
        const amountInput = document.getElementById('convert-amount');
        const balance = this.convertMode === 'shield' 
          ? parseFloat(walletState.publicBalance) || 0
          : parseFloat(walletState.privateBalance) || 0;
        
        // Generate random integer between 1 and half of balance
        const maxRandom = Math.max(1, Math.floor(balance / 2));
        const randomAmount = Math.floor(Math.random() * maxRandom);
        amountInput.value = randomAmount.toString();
        // Trigger input event to update button state
        amountInput.dispatchEvent(new Event('input'));
      });
    }
    
    if (convertMaxBtn) {
      convertMaxBtn.addEventListener('click', () => {
        const amountInput = document.getElementById('convert-amount');
        if (this.convertMode === 'shield') {
          amountInput.value = walletState.publicBalance;
        } else {
          amountInput.value = walletState.privateBalance;
        }
        // Trigger input event to update button state
        amountInput.dispatchEvent(new Event('input'));
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

    // Quick buttons (RANDOM and MAX)
    document.querySelectorAll('.quick-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.target.dataset.mode;
        const action = e.target.dataset.action;
        
        let balance = 0;
        let amountInput;
        
        if (mode === 'erc20') {
          amountInput = document.getElementById('erc20-amount');
          balance = parseFloat(walletState.publicBalance) || 0;
        } else if (mode === 'private') {
          amountInput = document.getElementById('private-amount');
          balance = parseFloat(walletState.privateBalance) || 0;
        } else if (mode === 'shield') {
          amountInput = document.getElementById('shield-amount');
          balance = parseFloat(walletState.publicBalance) || 0;
        } else if (mode === 'unshield') {
          amountInput = document.getElementById('unshield-amount');
          balance = parseFloat(walletState.privateBalance) || 0;
        }
        
        if (amountInput) {
          if (action === 'random') {
            // Generate random integer between 1 and half of balance
            const maxRandom = Math.max(1, Math.floor(balance / 2));
            const randomAmount = Math.floor(Math.random() * maxRandom) + 1;
            amountInput.value = randomAmount.toString();
          } else {
            amountInput.value = balance.toFixed(2);
          }
          // Trigger input event to update button state
          amountInput.dispatchEvent(new Event('input'));
        }
      });
    });

    // ERC20 Transfer validation
    const erc20RecipientInput = document.getElementById('erc20-recipient');
    const erc20AmountInput = document.getElementById('erc20-amount');
    
    const validateERC20Form = () => {
      if (!erc20TransferBtn) return;
      
      const recipient = erc20RecipientInput?.value.trim() || '';
      const amount = erc20AmountInput?.value.trim() || '';
      
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(recipient);
      const isValidAmount = amount && !isNaN(amount) && parseFloat(amount) > 0;
      
      erc20TransferBtn.disabled = !(isValidAddress && isValidAmount);
    };
    
    if (erc20RecipientInput) {
      erc20RecipientInput.addEventListener('input', validateERC20Form);
    }
    if (erc20AmountInput) {
      erc20AmountInput.addEventListener('input', validateERC20Form);
    }
    validateERC20Form(); // Initial check

    // Private transfer address input with debounced lookup and validation
    const privateRecipientInput = document.getElementById('private-recipient');
    const privateAmountInput = document.getElementById('private-amount');
    
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
    
    // Trigger validation when amount changes
    if (privateAmountInput) {
      privateAmountInput.addEventListener('input', () => {
        // Directly call updateTransferButtonState with current lookup result
        const address = privateRecipientInput?.value.trim();
        if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
          // Re-check recipient status
          handleTransferLookup(address);
        } else {
          // No valid address, disable button
          if (privateTransferBtn) {
            privateTransferBtn.disabled = true;
            privateTransferBtn.style.opacity = '0.5';
          }
        }
      });
    }

    // Custom events
    window.addEventListener('register-mpk', () => registerMPK());
    
    window.addEventListener('show-transaction', (e) => {
      const tx = walletState.transactions[e.detail.index];
      if (tx) {
        UI.showTransactionDetails(tx, walletState.chainId);
      }
    });


    window.addEventListener('copy-to-clipboard', async (e) => {
      const success = await copyToClipboard(e.detail.text);
      if (success) {
        console.log('Copied to clipboard');
      } else {
        console.error('Failed to copy to clipboard');
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
    const logoImg = document.querySelector('.logo-img');
    
    if (isEnabled) {
      // Add privacy-active class to logo
      if (logoImg) {
        logoImg.classList.add('privacy-active');
      }
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
      // Remove privacy-active class from logo
      if (logoImg) {
        logoImg.classList.remove('privacy-active');
      }
      
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

  toggleConvertMode() {
    const convertActionBtn = document.getElementById('convert-action-btn');
    
    if (this.convertMode === 'shield') {
      // Switch to Unshield mode
      this.convertMode = 'unshield';
      if (convertActionBtn) {
        convertActionBtn.textContent = 'Unshield';
        convertActionBtn.classList.remove('shield');
        convertActionBtn.classList.add('unshield');
      }
    } else {
      // Switch to Shield mode
      this.convertMode = 'shield';
      if (convertActionBtn) {
        convertActionBtn.textContent = 'Shield';
        convertActionBtn.classList.remove('unshield');
        convertActionBtn.classList.add('shield');
      }
    }
  }
}

// Initialize app when DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const app = new PrivacyWalletApp();
  await app.init();
});

