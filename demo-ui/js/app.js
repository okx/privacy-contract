// Main Application Entry Point
import { loadContractConfig, connectWallet, registerMPK, setupProviderListeners, handleTransferLookup, walletState, refreshBalances } from './wallet.js';
import { handleShield, handleUnshield, handleUnifiedTransfer } from './transactions.js';
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
    const transferBtn = document.getElementById('transfer-btn');
    const shieldBtn = document.getElementById('shield-btn');
    const unshieldBtn = document.getElementById('unshield-btn');
    
    if (transferBtn) {
      transferBtn.addEventListener('click', () => {
        const recipientInput = document.getElementById('transfer-recipient');
        const amountInput = document.getElementById('transfer-amount');
        const privacyModeToggle = document.getElementById('privacy-mode-toggle');
        const usePrivacy = privacyModeToggle ? privacyModeToggle.checked : false;
        
        handleUnifiedTransfer(recipientInput.value.trim(), amountInput.value.trim(), usePrivacy);
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
        
        if (mode === 'transfer') {
          amountInput = document.getElementById('transfer-amount');
          const privacyModeToggle = document.getElementById('privacy-mode-toggle');
          const usePrivacy = privacyModeToggle?.checked || false;
          balance = usePrivacy 
            ? parseFloat(walletState.privateBalance) || 0
            : parseFloat(walletState.publicBalance) || 0;
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

    // Unified Transfer form validation and privacy toggle
    const transferRecipientInput = document.getElementById('transfer-recipient');
    const transferAmountInput = document.getElementById('transfer-amount');
    const privacyModeToggle = document.getElementById('privacy-mode-toggle');
    const mpkStatusContainer = document.getElementById('mpk-status-container');
    
    // Update flow indicator based on privacy toggle (export to window for ui.js)
    const updateTransferFlow = (usePrivacy, recipientRegistered = null) => {
      const sourceIcon = document.getElementById('transfer-flow-source-icon');
      const sourceLabel = document.getElementById('transfer-flow-source-label');
      const methodIcon = document.getElementById('transfer-flow-method-icon');
      const methodLabel = document.getElementById('transfer-flow-method-label');
      const destIcon = document.getElementById('transfer-flow-dest-icon');
      const destLabel = document.getElementById('transfer-flow-dest-label');
      
      if (usePrivacy) {
        // Privacy payment
        sourceIcon.className = 'flow-icon private';
        sourceIcon.textContent = '🔐';
        sourceLabel.textContent = 'Your Private';
        
        if (recipientRegistered === true) {
          // Private → Private
          methodIcon.style.background = 'var(--accent-purple-dim)';
          methodIcon.style.color = 'var(--accent-purple)';
          methodIcon.textContent = '🔄';
          methodLabel.textContent = 'Private Transfer';
          destIcon.className = 'flow-icon private';
          destIcon.textContent = '🔐';
          destLabel.textContent = 'Their Private';
        } else if (recipientRegistered === false) {
          // Private → Public (Unshield)
          methodIcon.style.background = 'var(--accent-orange-dim)';
          methodIcon.style.color = 'var(--accent-orange)';
          methodIcon.textContent = '📤';
          methodLabel.textContent = 'Private to Public';
          destIcon.className = 'flow-icon wallet';
          destIcon.textContent = '💳';
          destLabel.textContent = 'Their Public';
        } else {
          // Unknown
          methodIcon.style.background = 'var(--accent-purple-dim)';
          methodIcon.style.color = 'var(--accent-purple)';
          methodIcon.textContent = '🔄';
          methodLabel.textContent = 'Privacy Transfer';
          destIcon.className = 'flow-icon';
          destIcon.textContent = '❓';
          destLabel.textContent = 'Recipient';
        }
      } else {
        // Public payment (ERC20)
        sourceIcon.className = 'flow-icon wallet';
        sourceIcon.textContent = '💳';
        sourceLabel.textContent = 'Your Wallet';
        methodIcon.style.background = 'var(--accent-blue-dim)';
        methodIcon.style.color = 'var(--accent-blue)';
        methodIcon.textContent = '📤';
        methodLabel.textContent = 'ERC20 Transfer';
        destIcon.className = 'flow-icon wallet';
        destIcon.textContent = '💳';
        destLabel.textContent = 'Recipient';
      }
    };
    
    // Export updateTransferFlow to window for ui.js
    window.updateTransferFlow = updateTransferFlow;
    
    // Privacy mode toggle change handler
    if (privacyModeToggle) {
      privacyModeToggle.addEventListener('change', (e) => {
        const usePrivacy = e.target.checked;
        
        // Show/hide MPK status indicator
        if (mpkStatusContainer) {
          mpkStatusContainer.style.display = usePrivacy ? 'flex' : 'none';
        }
        
        // Update flow indicator
        updateTransferFlow(usePrivacy);
        
        // Re-check recipient if privacy enabled
        if (usePrivacy && transferRecipientInput) {
          const address = transferRecipientInput.value.trim();
          if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
            handleTransferLookup(address);
          }
        }
        
        // Validate form
        validateUnifiedTransferForm();
      });
    }
    
    // Unified transfer validation
    const validateUnifiedTransferForm = () => {
      if (!transferBtn) return;
      
      const recipient = transferRecipientInput?.value.trim() || '';
      const amount = transferAmountInput?.value.trim() || '';
      const usePrivacy = privacyModeToggle?.checked || false;
      
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(recipient);
      const isValidAmount = amount && !isNaN(amount) && parseFloat(amount) > 0;
      
      // Check balance
      let hasBalance = false;
      if (usePrivacy) {
        hasBalance = parseFloat(walletState.privateBalance) >= parseFloat(amount || 0);
      } else {
        hasBalance = parseFloat(walletState.publicBalance) >= parseFloat(amount || 0);
      }
      
      const shouldEnable = isValidAddress && isValidAmount && hasBalance;
      
      if (shouldEnable) {
        transferBtn.disabled = false;
        transferBtn.style.opacity = '1';
        transferBtn.style.cursor = 'pointer';
        transferBtn.title = '';
      } else {
        transferBtn.disabled = true;
        transferBtn.style.opacity = '0.5';
        transferBtn.style.cursor = 'not-allowed';
        
        if (!isValidAddress) {
          transferBtn.title = 'Please enter a valid recipient address';
        } else if (!isValidAmount) {
          transferBtn.title = 'Please enter a valid amount';
        } else if (!hasBalance) {
          transferBtn.title = usePrivacy ? 'Insufficient private balance' : 'Insufficient public balance';
        }
      }
    };
    
    if (transferRecipientInput) {
      const debouncedLookup = debounce((address) => {
        if (!address) {
          handleTransferLookup(null);
          validateUnifiedTransferForm();
          return;
        }
        
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          validateUnifiedTransferForm();
          return;
        }
        
        const usePrivacy = privacyModeToggle?.checked || false;
        if (usePrivacy) {
          handleTransferLookup(address);
        } else {
          validateUnifiedTransferForm();
        }
      }, 500);

      transferRecipientInput.addEventListener('input', (e) => {
        debouncedLookup(e.target.value.trim());
      });
    }
    
    if (transferAmountInput) {
      transferAmountInput.addEventListener('input', validateUnifiedTransferForm);
    }
    
    validateUnifiedTransferForm(); // Initial check

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
    const privacyStatus = document.getElementById('privacy-status');
    const logoImg = document.querySelector('.logo-img');
    const mpkStatusContainer = document.getElementById('mpk-status-container');
    const transferRecipient = document.getElementById('transfer-recipient');
    
    if (isEnabled) {
      // Add privacy-active class to logo
      if (logoImg) {
        logoImg.classList.add('privacy-active');
      }
      
      // Show MPK status indicator
      if (mpkStatusContainer) {
        mpkStatusContainer.style.display = 'flex';
      }
      
      // Update flow indicator
      if (typeof window.updateTransferFlow === 'function') {
        window.updateTransferFlow(true);
      }
      
      // Re-check recipient if address entered
      if (transferRecipient) {
        const address = transferRecipient.value.trim();
        if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
          handleTransferLookup(address);
        }
      }
      
      // Update status display
      if (privacyStatus) {
        const statusDot = privacyStatus.querySelector('.status-dot');
        const statusText = privacyStatus.querySelector('.status-text');
        
        if (walletState.isRegistered) {
          statusDot.classList.remove('unregistered');
          statusDot.classList.add('registered');
          statusText.textContent = 'Activated';
        } else {
          statusDot.classList.remove('registered');
          statusDot.classList.add('unregistered');
          statusText.textContent = 'Registering...';
        }
      }
      
      // Check if user needs to register (registerMPK will handle MPK generation internally)
      if (walletState.account && !walletState.isRegistered) {
        console.log('Privacy mode enabled, prompting registration...');
        window.dispatchEvent(new CustomEvent('register-mpk'));
      }
    } else {
      // Remove privacy-active class from logo
      if (logoImg) {
        logoImg.classList.remove('privacy-active');
      }
      
      // Hide MPK status indicator
      if (mpkStatusContainer) {
        mpkStatusContainer.style.display = 'none';
      }
      
      // Update flow indicator
      if (typeof window.updateTransferFlow === 'function') {
        window.updateTransferFlow(false);
      }
      
      // Update status display
      if (privacyStatus) {
        const statusDot = privacyStatus.querySelector('.status-dot');
        const statusText = privacyStatus.querySelector('.status-text');
        
        if (walletState.isRegistered) {
          statusDot.classList.remove('registered');
          statusDot.classList.add('unregistered');
          statusText.textContent = 'Not activated';
        } else {
          statusDot.classList.remove('registered');
          statusDot.classList.add('unregistered');
          statusText.textContent = 'Not registered';
        }
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
      // Switch to Private to Public mode
      this.convertMode = 'unshield';
      if (convertActionBtn) {
        convertActionBtn.textContent = 'Private to Public';
        convertActionBtn.classList.remove('shield');
        convertActionBtn.classList.add('unshield');
      }
    } else {
      // Switch to Public to Private mode
      this.convertMode = 'shield';
      if (convertActionBtn) {
        convertActionBtn.textContent = 'Public to Private';
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

