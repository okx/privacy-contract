// Wallet Management Module
import { CONFIG, contracts, erc20TokenInfo, loadContractConfig as loadConfig } from './config.js';
import { ensureEthers, getMetaMaskProvider, storage } from './utils.js';
import { TX_TYPES, TX_LABELS, TX_ICONS } from './constants.js';
import * as UI from './ui.js';

// Wallet State (encapsulated)
class WalletState {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.account = null;
    this.chainId = null;
    this.publicBalance = '0.00';
    this.privateBalance = '0.00';
    this.mpk = null;
    this.isRegistered = false;
    this.transactions = [];
    this.railgunWallet = null;
    this.isConnecting = false;
    this.derivedKeys = {
      spendingKey: null,
      viewingKey: null,
      viewingPublicKey: null
    };
  }

  reset() {
    this.provider = null;
    this.signer = null;
    this.account = null;
    this.chainId = null;
    this.publicBalance = '0.00';
    this.privateBalance = '0.00';
    this.mpk = null;
    this.isRegistered = false;
    this.railgunWallet = null;
  }
}

export const state = new WalletState();

// Initialize RailgunWalletBrowser
async function initializeRailgunWallet() {
  const { RailgunWalletBrowser } = window.RailgunWallet;
  state.railgunWallet = new RailgunWalletBrowser();
  
  const providerAdapter = {
    getNetwork: async () => ({ chainId: state.chainId }),
    getTransactionReceipt: async (txHash) => {
      const receipt = await state.provider.getTransactionReceipt(txHash);
      return {
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash || receipt.hash || txHash,
        hash: receipt.transactionHash || receipt.hash || txHash,
        logs: receipt.logs
      };
    }
  };
  
  const contractAdapter = {
    address: contracts.railgun,
    interface: {
      parseLog: (log) => {
        const ethersLib = ensureEthers();
        const iface = new ethersLib.utils.Interface(CONFIG.RAILGUN_ABI);
        return iface.parseLog(log);
      }
    }
  };
  
  await state.railgunWallet.initialize(providerAdapter, contractAdapter);
  state.railgunWallet.setCurrentAccount(state.account);
}

// Chain detection and validation
async function switchToTargetChain(provider) {
  const currentChainIdHex = await provider.request({ method: 'eth_chainId' });
  const currentChainId = parseInt(currentChainIdHex, 16);
  
  console.log('📡 Network status:');
  console.log('   Current Chain ID:', currentChainId);
  console.log('   Expected Chain ID:', CONFIG.TARGET_CHAIN.chainId);
  console.log('   Expected RPC:', CONFIG.TARGET_CHAIN.rpcUrl);
  
  if (currentChainId !== CONFIG.TARGET_CHAIN.chainId) {
    console.error('❌ Network mismatch!');
    console.error(`   Please switch MetaMask to ${CONFIG.TARGET_CHAIN.chainName} (Chain ID: ${CONFIG.TARGET_CHAIN.chainId})`);
    throw new Error(`Network mismatch: Connected to Chain ${currentChainId}, but expected Chain ${CONFIG.TARGET_CHAIN.chainId}. Please switch network in MetaMask.`);
  }
  
  console.log('✅ Network matched!');
}

// Load ERC20 token info
export async function loadERC20TokenInfo() {
  if (contracts.testERC20 && contracts.testERC20 !== '0x0000000000000000000000000000000000000000') {
    erc20TokenInfo.address = contracts.testERC20;
    UI.updateERC20TokenDisplay();
  }
  
  if (!state.provider || !contracts.testERC20 || contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
    return;
  }
  
  const ethersLib = ensureEthers();
  
  try {
    const erc20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, state.provider);
    
    try {
      erc20TokenInfo.symbol = await erc20.symbol();
    } catch (e) {
      // Use default
    }
    
    try {
      erc20TokenInfo.name = await erc20.name();
    } catch (e) {
      // Use default
    }
    
    try {
      erc20TokenInfo.decimals = await erc20.decimals();
    } catch (e) {
      // Use default
    }
    
    UI.updateERC20TokenDisplay();
  } catch (error) {
    console.warn('Failed to load ERC20 token info:', error.message);
  }
}

// Connect wallet
export async function connectWallet() {
  if (state.isConnecting) return;
  state.isConnecting = true;
  
  try {
    if (!window.ethereum) {
      console.error('MetaMask Not Found: Please install MetaMask extension');
      return;
    }
    
    const provider = getMetaMaskProvider();
    if (!provider) {
      console.error('Connection Error: Could not detect MetaMask provider');
      return;
    }
    
    const existingAccounts = await provider.request({ method: 'eth_accounts' });
    const accounts = existingAccounts?.length > 0 
      ? existingAccounts 
      : await provider.request({ method: 'eth_requestAccounts' });

    const ethersLib = ensureEthers();
    state.provider = new ethersLib.providers.Web3Provider(provider);
    state.provider.pollingInterval = 200;  // Fast polling: 200ms for local dev
    state.signer = state.provider.getSigner();
    state.account = accounts[0];
    
    await switchToTargetChain(provider);
    const network = await state.provider.getNetwork();
    state.chainId = network.chainId;
    
    // Force fast polling for local development (after network is detected)
    state.provider.pollingInterval = 200;
    console.log('Provider polling interval set to:', state.provider.pollingInterval, 'ms');

    await loadERC20TokenInfo();
    
    // Wait for RailgunWallet
    await new Promise((resolve) => {
      if (typeof RailgunWallet !== 'undefined' && RailgunWallet.RailgunWalletBrowser) {
        resolve();
      } else {
        const check = setInterval(() => {
          if (typeof RailgunWallet !== 'undefined' && RailgunWallet.RailgunWalletBrowser) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      }
    });
    
    await initializeRailgunWallet();
    loadTransactions();
    await refreshBalances();
    updateUI();
    
    // Trigger MPK lookup if on transfer tab after connecting
    retriggerTransferLookup();
    
    console.log('Wallet Connected:', state.account);
    
  } catch (error) {
    console.error('Connection error:', error);
    
    if (error.code === 4001) {
      console.warn('Connection Rejected:', error.message);
    } else if (error.code === -32002) {
      console.info('Pending Request:', error.message);
    } else {
      console.error('Connection Failed:', error.message);
    }
  } finally {
    state.isConnecting = false;
  }
}

// Retry helper with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 500) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// Refresh balances (with race condition fix and retry)
export async function refreshBalances() {
  if (!state.provider || !state.account) {
    return;
  }

  if (!contracts.testERC20 || contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
    return;
  }

  const ethersLib = ensureEthers();
  const currentAccount = state.account;  // Save current account to detect changes
  
  try {
    // Retry public balance query
    const erc20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, state.provider);
    const balance = await retryWithBackoff(() => erc20.balanceOf(currentAccount));
    const decimals = erc20TokenInfo.decimals || 18;
    const formattedBalance = ethersLib.utils.formatUnits(balance, decimals);
    
    // Check if account changed during async operation
    if (currentAccount !== state.account) {
      console.log('Account changed during balance refresh, ignoring stale data');
      return;
    }
    
    state.publicBalance = parseFloat(formattedBalance).toFixed(2);
    
    // Get private balance with retry
    if (state.railgunWallet) {
      const privateBalance = await retryWithBackoff(() => 
        state.railgunWallet.getBalance(
          currentAccount,
          contracts.testERC20,
          0 // TokenType.ERC20
        )
      );
      
      // Check again before updating
      if (currentAccount !== state.account) {
        return;
      }
      
      state.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);
    } else if (!state.privateBalance) {
      state.privateBalance = '0.00';
    }
    
    updateUI();
  } catch (error) {
    console.warn('Failed to refresh balances after retries:', error.message);
  }
}

// Generate MPK
export async function generateMPK() {
  const ethersLib = ensureEthers();
  
  const savedKeys = await state.railgunWallet.loadKeys(state.account);
  
  let keys;
  if (savedKeys && savedKeys.spendingKey && savedKeys.viewingKey) {
    keys = {
      spendingKey: savedKeys.spendingKey,
      viewingKey: savedKeys.viewingKey,
    };
  } else {
    const signature = await state.signer.signMessage('Railgun Spendingkey');
    keys = await state.railgunWallet.generateKeys(state.account, signature);
  }
  
  state.derivedKeys.viewingPublicKey = await state.railgunWallet.getViewingPublicKey(keys.viewingKey);
  const mpkBytes = await state.railgunWallet.getMPK(keys.spendingKey, keys.viewingKey);
  state.mpk = ethersLib.utils.hexlify(mpkBytes);
  
  const spendingKeyArray = ethersLib.utils.arrayify('0x' + keys.spendingKey);
  const viewingKeyArray = ethersLib.utils.arrayify('0x' + keys.viewingKey);
  
  state.derivedKeys.spendingKey = spendingKeyArray;
  state.derivedKeys.viewingKey = viewingKeyArray;
  
  await checkRegistrationStatus();
  updateUI();
}

// Check registration status
async function checkRegistrationStatus() {
  if (!state.provider || !state.account || contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    state.isRegistered = false;
    await autoSetPrivacyMode(false, false);
    return;
  }

  try {
    const registry = new ethers.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, state.provider);
    const userInfo = await registry.getUserInfo(state.account);
    
    state.isRegistered = userInfo.mpk !== '0x0000000000000000000000000000000000000000000000000000000000000000';
    
    // If registered, check allowance and auto-approve if needed
    if (state.isRegistered && contracts.testERC20 !== '0x0000000000000000000000000000000000000000') {
      const ethersLib = ensureEthers();
      const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, state.provider);
      const allowance = await testERC20.allowance(state.account, contracts.railgun);
      
      if (allowance.eq(0)) {
        console.log('⚠️ Token not approved (allowance = 0), auto-triggering approval...');
        // Set privacy mode to false temporarily
        await autoSetPrivacyMode(true, false);
        
        try {
          const testERC20Signer = testERC20.connect(state.signer);
          const approveTx = await testERC20Signer.approve(contracts.railgun, ethersLib.constants.MaxUint256);
          await approveTx.wait();
          console.log('✅ Token approved');
          
          // After successful approval, enable privacy mode
          await autoSetPrivacyMode(true, true);
        } catch (approveError) {
          if (approveError.code === 4001) {
            console.warn('⚠️ Token approval cancelled by user');
          } else {
            console.warn('⚠️ Token approval failed:', approveError.message);
          }
          // Approval failed, keep privacy mode off
          await autoSetPrivacyMode(true, false);
        }
      } else {
        console.log('✅ Token already approved. Allowance:', ethersLib.utils.formatUnits(allowance, 18));
        // Fully activated: registered + approved, enable privacy mode
        await autoSetPrivacyMode(true, true);
      }
    } else if (!state.isRegistered) {
      // Not registered, disable privacy mode
      await autoSetPrivacyMode(false, false);
    }
  } catch (error) {
    console.warn('Failed to check registration status:', error);
    state.isRegistered = false;
    await autoSetPrivacyMode(false, false);
  }
}

// Auto set privacy mode based on activation status
async function autoSetPrivacyMode(isRegistered, isApproved) {
  const privacyToggle = document.getElementById('privacy-mode-toggle');
  if (!privacyToggle) return;
  
  const shouldEnable = isRegistered && isApproved;
  
  // Only update if different from current state
  if (privacyToggle.checked !== shouldEnable) {
    privacyToggle.checked = shouldEnable;
    
    // Trigger the change event to update UI
    const event = new Event('change', { bubbles: true });
    privacyToggle.dispatchEvent(event);
    
    if (shouldEnable) {
      console.log('✅ Privacy mode enabled automatically (registered + approved)');
    } else if (isRegistered && !isApproved) {
      console.log('⚠️ Privacy mode disabled (waiting for approval)');
    } else {
      console.log('ℹ️ Privacy mode disabled (not registered)');
    }
  }
}

// Register MPK
export async function registerMPK() {
  if (!state.signer || !state.account) {
    console.warn('Not Connected: Please connect your wallet first');
    return;
  }

  // Generate MPK first if not exists
  if (!state.mpk || !state.derivedKeys.viewingPublicKey) {
    console.log('MPK not found, generating...');
    await generateMPK();
    
    // Check again after generation
    if (!state.mpk || !state.derivedKeys.viewingPublicKey) {
      console.warn('MPK generation failed or cancelled');
      return;
    }
  }

  if (contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    console.error('Contract Not Found: MPKRegistry contract not deployed');
    return;
  }

  const ethersLib = ensureEthers();

  try {
    const registry = new ethersLib.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, state.signer);
    const viewingPublicKeyBytes32 = ethersLib.utils.hexZeroPad(
      ethersLib.utils.hexlify(state.derivedKeys.viewingPublicKey), 
      32
    );
    
    const tx = await registry.register(state.mpk, viewingPublicKeyBytes32);
    
    // Use fast polling for registration confirmation
    const { waitForTransactionFast } = await import('./utils.js');
    await waitForTransactionFast(state.provider, tx.hash);
    
    if (state.railgunWallet) {
      await state.railgunWallet.registerAccount(state.account);
    }

    state.isRegistered = true;
    updateUI();
    
    // Auto-approve token spending after registration
    console.log('🔄 Approving token spending...');
    try {
      const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, state.signer);
      const approveTx = await testERC20.approve(contracts.railgun, ethersLib.constants.MaxUint256);
      await waitForTransactionFast(state.provider, approveTx.hash);
      console.log('✅ Token approved. You can now Shield without additional approvals.');
      
      // Enable privacy mode after successful registration and approval
      await autoSetPrivacyMode(true, true);
    } catch (approveError) {
      console.warn('⚠️ Token approval failed:', approveError.message);
      // Registration succeeded but approval failed, keep privacy mode off
      await autoSetPrivacyMode(true, false);
    }
    
  } catch (error) {
    console.error('Registration failed:', error);
  }
}

// Lookup MPK
export async function lookupMPK(address) {
  const ethersLib = ensureEthers();
  if (!address || !ethersLib.utils.isAddress(address)) {
    return null;
  }

  if (!state.provider || contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  try {
    const registry = new ethersLib.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, state.provider);
    const userInfo = await registry.getUserInfo(address);
    
    const zeroMPK = '0x0000000000000000000000000000000000000000000000000000000000000000';
    if (userInfo.mpk === zeroMPK) {
      return null;
    }

    const viewingPublicKeyStr = typeof userInfo.viewingPublicKey === 'string' 
      ? userInfo.viewingPublicKey 
      : ethersLib.utils.hexlify(userInfo.viewingPublicKey);

    return {
      mpk: userInfo.mpk,
      viewingPublicKey: viewingPublicKeyStr
    };
  } catch (error) {
    console.error('Failed to lookup MPK:', error);
    return null;
  }
}

// Transaction management
function loadTransactions() {
  const saved = storage.get('railgun-transactions', []);
  if (state.account) {
    state.transactions = saved.filter(tx => 
      !tx.account || tx.account.toLowerCase() === state.account.toLowerCase()
    );
  } else {
    state.transactions = saved;
  }
  UI.updateTransactionHistory(state.transactions);
}

function saveTransactions() {
  const allTxs = storage.get('railgun-transactions', []);
  
  state.transactions.forEach(stateTx => {
    const index = allTxs.findIndex(tx => tx.txHash === stateTx.txHash);
    if (index !== -1) {
      allTxs[index] = stateTx;
    } else {
      allTxs.unshift(stateTx);
    }
  });
  
  // Keep only last 100 transactions
  if (allTxs.length > 100) {
    allTxs.splice(100);
  }
  
  storage.set('railgun-transactions', allTxs);
}

export function addTransaction(type, title, description, amount, txHash = null, status = 'success') {
  state.transactions.unshift({
    type,
    icon: TX_ICONS[type],
    title,
    description,
    amount,
    txHash,
    status,
    time: 'Just now',
    timestamp: Date.now(),
    account: state.account
  });

  if (state.transactions.length > 50) {
    state.transactions = state.transactions.slice(0, 50);
  }

  UI.updateTransactionHistory(state.transactions);
  saveTransactions();
}

export function updateTransactionStatus(txHash, status, title = null, description = null) {
  const txIndex = state.transactions.findIndex(tx => tx.txHash === txHash);
  if (txIndex !== -1) {
    state.transactions[txIndex].status = status;
    if (title) state.transactions[txIndex].title = title;
    if (description) state.transactions[txIndex].description = description;
    saveTransactions();
    UI.updateTransactionHistory(state.transactions);
  }
}

// UI update wrapper
function updateUI() {
  UI.updateConnectButton(state);
  UI.updateBalances(state);
  UI.updateAccountInfo(state);
  UI.updateMPKDisplay(state, state.derivedKeys);
  UI.updateTransactionHistory(state.transactions);
  
  // Update Shield MPK lookup for current user
  if (state.account) {
    handleShieldLookup(state.account);
  }
}

// MPK Lookup handlers
async function handleShieldLookup(address) {
  if (!address) {
    UI.updateShieldLookup(null, null, null);
    return;
  }
  
  const userInfo = await lookupMPK(address);
  if (userInfo) {
    UI.updateShieldLookup(userInfo.mpk, userInfo.viewingPublicKey, true);
  } else {
    UI.updateShieldLookup(null, null, false);
  }
}

export async function handleTransferLookup(address) {
  // If address is empty, reset UI
  if (!address) {
    UI.updateTransferLookup(null, null, null);
    return;
  }
  
  const ethersLib = ensureEthers();
  
  // Validate address format before lookup
  if (!ethersLib.utils.isAddress(address)) {
    // Invalid format - don't show error, just wait for user to finish typing
    // Only show error if it looks complete but invalid
    if (address.length >= 42) {
      UI.updateTransferLookup(null, null, 'invalid');
    }
    return;
  }
  
  // Valid address format - show checking state
  UI.updateTransferLookup(null, null, 'checking');
  
  // Trigger lookup
  console.log('Looking up MPK for:', address);
  const userInfo = await lookupMPK(address);
  if (userInfo) {
    UI.updateTransferLookup(userInfo.mpk, userInfo.viewingPublicKey, true);
  } else {
    UI.updateTransferLookup(null, null, false);
  }
}

// Helper: Re-trigger transfer lookup if on transfer tab
function retriggerTransferLookup() {
  // Check if currently on transfer tab
  const transferPanel = document.getElementById('transfer-panel');
  if (transferPanel && transferPanel.classList.contains('active')) {
    const transferAddressInput = document.getElementById('transfer-recipient');
    if (transferAddressInput) {
      const address = transferAddressInput.value.trim();
      // Only lookup if address exists and has valid format
      if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.log('Re-triggering MPK lookup after account change');
        handleTransferLookup(address);
      }
    }
  }
}

// Setup event listeners for account/chain changes
export function setupProviderListeners() {
  const provider = getMetaMaskProvider();
  if (!provider) return;
  
  provider.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) {
      state.reset();
      state.transactions = [];
      updateUI();
      console.info('Wallet disconnected');
    } else {
      state.publicBalance = '0.00';
      state.privateBalance = '0.00';
      connectWallet().then(() => {
        // Re-check recipient registration status after account change
        const transferRecipient = document.getElementById('transfer-recipient');
        const privacyModeToggle = document.getElementById('privacy-mode-toggle');
        
        if (transferRecipient && privacyModeToggle?.checked) {
          const address = transferRecipient.value.trim();
          if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
            console.log('Account changed, re-checking recipient registration...');
            handleTransferLookup(address);
          }
        }
      });
    }
  });

  provider.on('chainChanged', (chainIdHex) => {
    const chainId = parseInt(chainIdHex, 16);
    state.chainId = chainId;
    connectWallet();
  });
}

// Export helper for external use
export { retriggerTransferLookup };

// Export state and key functions
export { state as walletState };
export const loadContractConfig = loadConfig;
