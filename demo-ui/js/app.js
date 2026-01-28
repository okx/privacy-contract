// Main Application Entry Point - Refactored

import { loadContractConfig, connectWallet, registerMPK, setupProviderListeners, handleTransferLookup, walletState, refreshBalances } from './wallet.js';
import { handleShield, handleUnshield, handleUnifiedTransfer } from './transactions.js';
import * as UI from './ui.js';
import { waitForLibrary, debounce, copyToClipboard } from './utils.js';

// ==================== Main App Class ====================

class PrivacyWalletApp {
  constructor() {
    this.initialized = false;
    this.convertMode = 'shield';
    this.debouncedTransferLookup = debounce(handleTransferLookup, 500);
  }

  async init() {
    if (this.initialized) return;

    console.log('🚀 Initializing Privacy Wallet App...');
    console.log('Current time:', new Date().toLocaleString());

    try {
      await loadContractConfig();
      await waitForLibrary('ethers', 5000);
      console.log('✅ ethers.js loaded');

      UI.domCache.init();
      this.setupEventListeners();
      setupProviderListeners();

      this.initialized = true;
      console.log('✅ App initialized successfully');
      console.log('👉 Click "Connect Wallet" to start');

    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
    }
  }

  setupEventListeners() {
    this.setupWalletEvents();
    this.setupPrivacyModeEvents();
    this.setupConvertPanelEvents();
    this.setupTransferEvents();
    this.setupModalEvents();
    this.setupQuickButtons();
    this.setupFormValidation();
    this.setupCustomEvents();
    this.setupNavigation();
  }

  // ==================== Wallet Events ====================
  
  setupWalletEvents() {
    this.on('connect-btn', 'click', connectWallet);
  }

  // ==================== Privacy Mode Events ====================
  
  setupPrivacyModeEvents() {
    const privacyToggle = document.getElementById('privacy-mode-toggle');
    
    if (privacyToggle) {
      privacyToggle.addEventListener('change', (e) => {
        const usePrivacy = e.target.checked;
        const logoImg = document.getElementById('logo-img');
        const mpkStatusContainer = document.getElementById('mpk-status-container');
        
        // Update logo
        if (logoImg) {
          logoImg.classList.toggle('privacy-active', usePrivacy);
        }
        
        // Update MPK status
        if (mpkStatusContainer) {
          mpkStatusContainer.style.display = usePrivacy ? 'flex' : 'none';
          
          if (usePrivacy) {
            const statusDot = mpkStatusContainer.querySelector('.status-dot');
            const statusText = mpkStatusContainer.querySelector('.status-text');
            
            // Only update if elements exist
            if (statusDot && statusText) {
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
          }
          
          // Trigger registration if needed
          if (usePrivacy && walletState.account && !walletState.isRegistered) {
            console.log('Privacy mode enabled, prompting registration...');
            window.dispatchEvent(new CustomEvent('register-mpk'));
          }
        }
        
        // Update flow indicator
        if (typeof window.updateTransferFlow === 'function') {
          window.updateTransferFlow(usePrivacy);
        }
        
        // Re-validate forms
        this.validateAllForms();
      });
    }
  }

  // ==================== Convert Panel Events ====================
  
  setupConvertPanelEvents() {
    this.on('convert-switch-btn', 'click', () => this.toggleConvertMode());
    this.on('convert-action-btn', 'click', () => this.handleConvertAction());
    this.on('convert-random-btn', 'click', () => this.setQuickAmount('convert', 'random'));
    this.on('convert-max-btn', 'click', () => this.setQuickAmount('convert', 'max'));
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

  handleConvertAction() {
    const amountInput = document.getElementById('convert-amount');
    const amount = amountInput?.value.trim();
    
    if (this.convertMode === 'shield') {
      handleShield(amount);
    } else {
      handleUnshield(amount);
    }
  }

  // ==================== Transfer Events ====================
  
  setupTransferEvents() {
    this.on('transfer-btn', 'click', () => this.handleTransfer());
    
    const recipientInput = document.getElementById('transfer-recipient');
    if (recipientInput) {
      recipientInput.addEventListener('input', (e) => {
        const address = e.target.value.trim();
        const privacyToggle = document.getElementById('privacy-mode-toggle');
        
        if (privacyToggle?.checked && address) {
          this.debouncedTransferLookup(address);
        }
      });
    }
  }

  handleTransfer() {
    const recipientInput = document.getElementById('transfer-recipient');
    const amountInput = document.getElementById('transfer-amount');
    const privacyToggle = document.getElementById('privacy-mode-toggle');
    
    const recipient = recipientInput?.value.trim();
    const amount = amountInput?.value.trim();
    const usePrivacy = privacyToggle?.checked || false;
    
    handleUnifiedTransfer(recipient, amount, usePrivacy);
  }

  // ==================== Modal Events ====================
  
  setupModalEvents() {
    // Open modal buttons
    this.on('sidebar-shield-btn', 'click', () => this.openModal('shield'));
    this.on('sidebar-unshield-btn', 'click', () => this.openModal('unshield'));
    
    // Close buttons
    this.on('shield-modal-close', 'click', () => this.closeModal('shield'));
    this.on('unshield-modal-close', 'click', () => this.closeModal('unshield'));
    
    // Submit buttons
    this.on('shield-btn', 'click', () => {
      const amount = document.getElementById('shield-amount')?.value.trim();
      handleShield(amount);
    });
    
    this.on('unshield-btn', 'click', () => {
      const amount = document.getElementById('unshield-amount')?.value.trim();
      handleUnshield(amount);
    });
    
    // Click outside to close
    ['shield-modal', 'unshield-modal'].forEach(modalId => {
      const modal = document.getElementById(modalId);
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target.id === modalId) {
            this.closeModal(modalId.replace('-modal', ''));
          }
        });
      }
    });
  }

  openModal(type) {
    const modal = document.getElementById(`${type}-modal`);
    const amountInput = document.getElementById(`${type}-amount`);
    
    if (modal) {
      modal.classList.add('active');
      if (amountInput) {
        amountInput.value = '';
        amountInput.focus();
      }
    }
  }

  closeModal(type) {
    const modal = document.getElementById(`${type}-modal`);
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // ==================== Quick Buttons ====================
  
  setupQuickButtons() {
    document.querySelectorAll('.quick-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.target.dataset.mode;
        const action = e.target.dataset.action;
        this.setQuickAmount(mode, action);
      });
    });
  }

  setQuickAmount(mode, action) {
    const config = {
      transfer: {
        input: 'transfer-amount',
        getBalance: () => {
          const privacyToggle = document.getElementById('privacy-mode-toggle');
          return privacyToggle?.checked 
            ? parseFloat(walletState.privateBalance) || 0
            : parseFloat(walletState.publicBalance) || 0;
        }
      },
      shield: {
        input: 'shield-amount',
        getBalance: () => parseFloat(walletState.publicBalance) || 0
      },
      unshield: {
        input: 'unshield-amount',
        getBalance: () => parseFloat(walletState.privateBalance) || 0
      },
      convert: {
        input: 'convert-amount',
        getBalance: () => {
          return this.convertMode === 'shield'
            ? parseFloat(walletState.publicBalance) || 0
            : parseFloat(walletState.privateBalance) || 0;
        }
      }
    };

    const modeConfig = config[mode];
    if (!modeConfig) return;

    const amountInput = document.getElementById(modeConfig.input);
    if (!amountInput) return;

    const balance = modeConfig.getBalance();
    
    if (action === 'random') {
      const maxRandom = Math.max(1, Math.floor(balance / 2));
      const randomAmount = Math.floor(Math.random() * maxRandom) + 1;
      amountInput.value = randomAmount.toString();
    } else {
      amountInput.value = balance.toFixed(2);
    }
    
    amountInput.dispatchEvent(new Event('input'));
  }

  // ==================== Form Validation ====================
  
  setupFormValidation() {
    // Transfer form
    const transferInputs = ['transfer-recipient', 'transfer-amount'];
    transferInputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', () => this.validateTransferForm());
      }
    });

    // Modal forms
    this.setupAmountValidation('shield-amount', 'shield-btn');
    this.setupAmountValidation('unshield-amount', 'unshield-btn');
    this.setupAmountValidation('convert-amount', 'convert-action-btn');
  }

  setupAmountValidation(inputId, buttonId) {
    const input = document.getElementById(inputId);
    const button = document.getElementById(buttonId);
    
    if (input && button) {
      input.addEventListener('input', () => {
        const amount = parseFloat(input.value);
        button.disabled = !(amount > 0);
      });
    }
  }

  validateTransferForm() {
    const recipientInput = document.getElementById('transfer-recipient');
    const amountInput = document.getElementById('transfer-amount');
    const transferBtn = document.getElementById('transfer-btn');
    
    if (!recipientInput || !amountInput || !transferBtn) return;

    const recipient = recipientInput.value.trim();
    const amount = parseFloat(amountInput.value);
    
    const isValid = recipient && /^0x[a-fA-F0-9]{40}$/.test(recipient) && amount > 0;
    transferBtn.disabled = !isValid;
  }

  validateAllForms() {
    this.validateTransferForm();
  }

  // ==================== Custom Events ====================
  
  setupCustomEvents() {
    window.addEventListener('register-mpk', () => registerMPK());
    
    window.addEventListener('show-transaction', (e) => {
      const tx = walletState.transactions[e.detail.index];
      if (tx?.txHash) {
        const blockExplorerUrl = window.CONFIG?.TARGET_CHAIN?.blockExplorerUrl;
        if (blockExplorerUrl) {
          window.open(`${blockExplorerUrl}/tx/${tx.txHash}`, '_blank');
        } else {
          console.log('Transaction Hash:', tx.txHash);
        }
      }
    });

    window.addEventListener('copy-address', async (e) => {
      const success = await copyToClipboard(e.detail.address);
      if (success) {
        UI.showToast('Address copied!', 'success');
      }
    });

    window.addEventListener('refresh-balances', () => refreshBalances());
  }

  // ==================== Navigation ====================
  
  setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPanel = link.dataset.panel;
        this.switchPanel(targetPanel);
      });
    });
  }

  switchPanel(panelName) {
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.panel === panelName);
    });

    // Update panels
    document.querySelectorAll('.panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `${panelName}-panel`);
    });
  }

  // ==================== Helpers ====================
  
  on(elementId, event, handler) {
    const element = document.getElementById(elementId);
    if (element) {
      element.addEventListener(event, handler);
    }
  }
}

// ==================== Transfer Flow Visualization ====================

window.updateTransferFlow = (usePrivacy, recipientRegistered = null) => {
  const elements = {
    sourceIcon: document.getElementById('transfer-flow-source-icon'),
    sourceLabel: document.getElementById('transfer-flow-source-label'),
    methodIcon: document.getElementById('transfer-flow-method-icon'),
    methodLabel: document.getElementById('transfer-flow-method-label'),
    destIcon: document.getElementById('transfer-flow-dest-icon'),
    destLabel: document.getElementById('transfer-flow-dest-label')
  };

  if (!elements.sourceIcon) return;

  if (usePrivacy) {
    setFlowState(elements, 'private', recipientRegistered);
  } else {
    setFlowState(elements, 'public');
  }
};

function setFlowState(elements, type, recipientRegistered = null) {
  const states = {
    private: {
      source: { icon: '🔐', label: 'Your Private', class: 'private' },
      method: recipientRegistered === true
        ? { icon: '🔄', label: 'Private Transfer', bg: 'var(--accent-purple-dim)', color: 'var(--accent-purple)' }
        : recipientRegistered === false
        ? { icon: '📤', label: 'Private to Public', bg: 'var(--accent-orange-dim)', color: 'var(--accent-orange)' }
        : { icon: '🔄', label: 'Privacy Transfer', bg: 'var(--accent-purple-dim)', color: 'var(--accent-purple)' },
      dest: recipientRegistered === true
        ? { icon: '🔐', label: 'Their Private', class: 'private' }
        : recipientRegistered === false
        ? { icon: '💳', label: 'Their Public', class: 'wallet' }
        : { icon: '❓', label: 'Recipient', class: '' }
    },
    public: {
      source: { icon: '💳', label: 'Your Wallet', class: 'wallet' },
      method: { icon: '📤', label: 'ERC20 Transfer', bg: 'var(--accent-blue-dim)', color: 'var(--accent-blue)' },
      dest: { icon: '💳', label: 'Recipient', class: 'wallet' }
    }
  };

  const state = states[type];
  
  // Safely update source
  if (elements.sourceIcon && elements.sourceLabel) {
    elements.sourceIcon.className = `flow-icon ${state.source.class}`;
    elements.sourceIcon.textContent = state.source.icon;
    elements.sourceLabel.textContent = state.source.label;
  }
  
  // Safely update method
  if (elements.methodIcon && elements.methodLabel) {
    elements.methodIcon.style.background = state.method.bg;
    elements.methodIcon.style.color = state.method.color;
    elements.methodIcon.textContent = state.method.icon;
    elements.methodLabel.textContent = state.method.label;
  }
  
  // Safely update destination
  if (elements.destIcon && elements.destLabel) {
    elements.destIcon.className = `flow-icon ${state.dest.class}`;
    elements.destIcon.textContent = state.dest.icon;
    elements.destLabel.textContent = state.dest.label;
  }
}

// ==================== Initialize App ====================

const app = new PrivacyWalletApp();

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.init());
} else {
  app.init();
}

// Export for debugging
window.PrivacyWalletApp = app;
