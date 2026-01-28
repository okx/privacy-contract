// Wallet Management Module
import { CONFIG, contracts, erc20TokenInfo, loadContractConfig } from './config.js';
import { ensureEthers, getMetaMaskProvider, storage, showToast } from './utils.js';
import * as UI from './ui.js';

// Wallet State
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
    this.isPrivacyEnabled = false;
    this.transactions = [];
    this.railgunWallet = null;
    this.isConnecting = false;
    this.isEnablingPrivacy = false; // Prevent duplicate enablePrivacy calls
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
    this.isPrivacyEnabled = false;
    this.railgunWallet = null;
    // Keep derived keys when resetting (they're account-specific and cached)
    // Only clear if account changes
  }
  
  resetKeys() {
    this.mpk = null;
    this.derivedKeys = {
      spendingKey: null,
      viewingKey: null,
      viewingPublicKey: null
    };
  }
}

export const walletState = new WalletState();

// Initialize RailgunWallet
async function initializeRailgunWallet() {
  const { RailgunWalletBrowser } = window.RailgunWallet;
  walletState.railgunWallet = new RailgunWalletBrowser();
  
  const providerAdapter = {
    getNetwork: async () => ({ chainId: walletState.chainId }),
    getTransactionReceipt: async (txHash) => {
      const receipt = await walletState.provider.getTransactionReceipt(txHash);
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
  
  await walletState.railgunWallet.initialize(providerAdapter, contractAdapter);
  walletState.railgunWallet.setCurrentAccount(walletState.account);
}

// Validate Network
async function validateNetwork(provider) {
  // Check if network config is loaded
  if (!CONFIG.TARGET_CHAIN.chainId) {
    throw new Error('网络配置未加载，请刷新页面后重试');
  }
  
  const currentChainIdHex = await provider.request({ method: 'eth_chainId' });
  const currentChainId = parseInt(currentChainIdHex, 16);
  
  console.log('📡 Network status:');
  console.log('   Current chain ID:', currentChainId);
  console.log('   Expected chain ID:', CONFIG.TARGET_CHAIN.chainId);
  
  if (currentChainId !== CONFIG.TARGET_CHAIN.chainId) {
    // Try to switch network automatically
    try {
      console.log('🔄 Attempting to switch network...');
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${CONFIG.TARGET_CHAIN.chainId.toString(16)}` }],
      });
      
      // Wait a bit for the switch to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify the switch
      const newChainIdHex = await provider.request({ method: 'eth_chainId' });
      const newChainId = parseInt(newChainIdHex, 16);
      
      if (newChainId !== CONFIG.TARGET_CHAIN.chainId) {
        throw new Error(`网络切换失败: 当前链 ID ${newChainId}，期望链 ID ${CONFIG.TARGET_CHAIN.chainId}`);
      }
      
      console.log('✅ Network switched successfully');
    } catch (switchError) {
      // If switch fails (e.g., chain not added), try to add it
      if (switchError.code === 4902 || switchError.message?.includes('not been added')) {
        console.log('➕ Network not found, attempting to add...');
        
        if (CONFIG.TARGET_CHAIN.rpcUrl) {
          try {
            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: `0x${CONFIG.TARGET_CHAIN.chainId.toString(16)}`,
                chainName: CONFIG.TARGET_CHAIN.chainName || 'Local Network',
                nativeCurrency: CONFIG.TARGET_CHAIN.nativeCurrency || {
                  name: 'Ether',
                  symbol: 'ETH',
                  decimals: 18
                },
                rpcUrls: [CONFIG.TARGET_CHAIN.rpcUrl],
                blockExplorerUrls: CONFIG.TARGET_CHAIN.blockExplorerUrl ? [CONFIG.TARGET_CHAIN.blockExplorerUrl] : []
              }],
            });
            
            // Wait for the network to be added
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log('✅ Network added successfully');
          } catch (addError) {
            throw new Error(`无法添加网络: ${addError.message}。请手动在 MetaMask 中添加网络（链 ID: ${CONFIG.TARGET_CHAIN.chainId}，RPC: ${CONFIG.TARGET_CHAIN.rpcUrl}）`);
          }
        } else {
          throw new Error(`网络未添加: 请在 MetaMask 中手动添加网络（链 ID: ${CONFIG.TARGET_CHAIN.chainId}）`);
        }
      } else {
        throw new Error(`网络不匹配: 当前连接到链 ${currentChainId}，但期望连接到链 ${CONFIG.TARGET_CHAIN.chainId}。${switchError.message || '请在 MetaMask 中切换网络'}`);
      }
    }
  }
  
  console.log('✅ Network matched!');
}

// Load ERC20 Token Info
export async function loadERC20TokenInfo() {
  if (contracts.testERC20 && contracts.testERC20 !== '0x0000000000000000000000000000000000000000') {
    erc20TokenInfo.address = contracts.testERC20;
  }
  
  if (!walletState.provider || !contracts.testERC20 || contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
    return;
  }
  
  const ethersLib = ensureEthers();
  
  try {
    const erc20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.provider);
    
    try { erc20TokenInfo.symbol = await erc20.symbol(); } catch {}
    try { erc20TokenInfo.name = await erc20.name(); } catch {}
    try { erc20TokenInfo.decimals = await erc20.decimals(); } catch {}
    
    UI.updateTokenDisplay();
  } catch (error) {
    console.warn('加载代币信息失败:', error.message);
  }
}

// Connect Wallet
export async function connectWallet() {
  if (walletState.isConnecting) return;
  walletState.isConnecting = true;
  
  // Save previous state to restore on error
  const previousAccount = walletState.account;
  
  try {
    if (!window.ethereum) {
      showToast('error', '未检测到钱包', '请安装 MetaMask 扩展');
      walletState.reset();
      UI.updateAll(walletState);
      return;
    }
    
    const provider = getMetaMaskProvider();
    if (!provider) {
      showToast('error', '连接失败', '无法检测到 MetaMask');
      walletState.reset();
      UI.updateAll(walletState);
      return;
    }
    
    const existingAccounts = await provider.request({ method: 'eth_accounts' });
    const accounts = existingAccounts?.length > 0 
      ? existingAccounts 
      : await provider.request({ method: 'eth_requestAccounts' });

    const ethersLib = ensureEthers();
    walletState.provider = new ethersLib.providers.Web3Provider(provider);
    walletState.signer = walletState.provider.getSigner();
    walletState.account = accounts[0];
    
    await validateNetwork(provider);
    walletState.chainId = (await walletState.provider.getNetwork()).chainId;

    await loadERC20TokenInfo();
    
    // Wait for RailgunWallet to load
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
    // Note: generateMPK is now called when user clicks "开通隐私功能" button, not during connection
    await checkRegistrationStatus(); // Check if already registered
    await refreshBalances();
    UI.updateAll(walletState);
    
    showToast('success', '钱包已连接', `地址: ${walletState.account.slice(0, 6)}...${walletState.account.slice(-4)}`);
    
  } catch (error) {
    console.error('Connection error:', error);
    
    // Reset wallet state on error
    walletState.reset();
    UI.updateAll(walletState);
    
    if (error.code === 4001) {
      showToast('warning', '连接已取消', '用户拒绝了连接请求');
    } else if (error.code === -32002) {
      showToast('info', '请求待处理', '请在 MetaMask 中确认连接请求');
    } else {
      // Check if it's a network mismatch error
      if (error.message && error.message.includes('网络不匹配')) {
        showToast('error', '网络不匹配', error.message);
      } else {
        showToast('error', '连接失败', error.message);
      }
    }
  } finally {
    walletState.isConnecting = false;
  }
}

// Refresh Balances
export async function refreshBalances() {
  if (!walletState.provider || !walletState.account) return;
  if (!contracts.testERC20 || contracts.testERC20 === '0x0000000000000000000000000000000000000000') return;

  const ethersLib = ensureEthers();
  const currentAccount = walletState.account;
  
  try {
    const erc20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.provider);
    const balance = await erc20.balanceOf(currentAccount);
    const decimals = erc20TokenInfo.decimals || 18;
    const formattedBalance = ethersLib.utils.formatUnits(balance, decimals);
    
    if (currentAccount !== walletState.account) return;
    
    walletState.publicBalance = parseFloat(formattedBalance).toFixed(2);
    
    // Get private balance
    if (walletState.railgunWallet && walletState.isPrivacyEnabled) {
      const privateBalance = await walletState.railgunWallet.getBalance(
        currentAccount,
        contracts.testERC20,
        0
      );
      
      if (currentAccount !== walletState.account) return;
      
      walletState.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);
    } else {
      walletState.privateBalance = '0.00';
    }
    
    UI.updateBalances(walletState);
  } catch (error) {
    console.warn('Refresh balance failed:', error.message);
  }
}

// Generate MPK (exported for use in enablePrivacy)
let isGeneratingMPK = false;
export async function generateMPK() {
  // Prevent duplicate calls
  if (isGeneratingMPK) {
    console.log('⏳ MPK generation already in progress, skipping...');
    return;
  }
  
  // If MPK already exists, skip
  if (walletState.mpk && walletState.derivedKeys.spendingKey && walletState.derivedKeys.viewingKey) {
    console.log('✅ MPK already generated, skipping...');
    return;
  }
  
  isGeneratingMPK = true;
  const ethersLib = ensureEthers();
  
  try {
    if (!walletState.railgunWallet) {
      throw new Error('RailgunWallet not initialized');
    }
    
    const savedKeys = await walletState.railgunWallet.loadKeys(walletState.account);
    
    let keys;
    if (savedKeys && savedKeys.spendingKey && savedKeys.viewingKey) {
      console.log('✅ Using saved keys from storage');
      keys = {
        spendingKey: savedKeys.spendingKey,
        viewingKey: savedKeys.viewingKey,
      };
    } else {
      console.log('🔐 No saved keys found, requesting signature...');
      if (!walletState.signer) {
        throw new Error('Signer not available');
      }
      const signature = await walletState.signer.signMessage('Railgun Spendingkey');
      keys = await walletState.railgunWallet.generateKeys(walletState.account, signature);
      console.log('✅ Keys generated and saved');
    }
    
    walletState.derivedKeys.viewingPublicKey = await walletState.railgunWallet.getViewingPublicKey(keys.viewingKey);
    const mpkBytes = await walletState.railgunWallet.getMPK(keys.spendingKey, keys.viewingKey);
    walletState.mpk = ethersLib.utils.hexlify(mpkBytes);
    
    const spendingKeyArray = ethersLib.utils.arrayify('0x' + keys.spendingKey);
    const viewingKeyArray = ethersLib.utils.arrayify('0x' + keys.viewingKey);
    
    walletState.derivedKeys.spendingKey = spendingKeyArray;
    walletState.derivedKeys.viewingKey = viewingKeyArray;
    
    // Don't call checkRegistrationStatus here - it will be called after registration
  } finally {
    isGeneratingMPK = false;
  }
}

// Check Registration Status
async function checkRegistrationStatus() {
  if (!walletState.provider || !walletState.account || contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    walletState.isRegistered = false;
    walletState.isPrivacyEnabled = false;
    return;
  }

  try {
    const ethersLib = ensureEthers();
    const registry = new ethersLib.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, walletState.provider);
    const userInfo = await registry.getUserInfo(walletState.account);
    
    walletState.isRegistered = userInfo.mpk !== '0x0000000000000000000000000000000000000000000000000000000000000000';
    walletState.isPrivacyEnabled = walletState.isRegistered;
    
    // Note: Token approval is now handled in the deposit modal, not here
  } catch (error) {
    console.warn('Check registration status failed:', error);
    walletState.isRegistered = false;
    walletState.isPrivacyEnabled = false;
  }
}

// Enable Privacy (Step 1: Generate keys, Step 2: Register MPK)
export async function enablePrivacy() {
  // Prevent duplicate calls
  if (walletState.isEnablingPrivacy) {
    console.log('⏳ Privacy enable already in progress, skipping...');
    return false;
  }

  if (!walletState.signer || !walletState.account) {
    showToast('warning', '请先连接钱包', '需要连接钱包才能启用隐私交易');
    return false;
  }

  if (contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    showToast('error', '合约未部署', 'MPKRegistry 合约未部署');
    return false;
  }

  // Check if already registered
  await checkRegistrationStatus();
  if (walletState.isRegistered) {
    showToast('info', '已开通', '隐私功能已经开通');
    return true;
  }

  walletState.isEnablingPrivacy = true;
  const ethersLib = ensureEthers();

  try {
    // Step 1: Generate keys if not already generated
    if (!walletState.mpk || !walletState.derivedKeys.viewingPublicKey) {
      // Generate MPK (this will request signature if keys don't exist)
      // No toast notification - user will see MetaMask signature request directly
      await generateMPK();
      
      if (!walletState.mpk || !walletState.derivedKeys.viewingPublicKey) {
        showToast('error', '密钥生成失败', '请重试');
        return false;
      }
    }

    // Step 2: Register MPK
    // No toast notification - user will see MetaMask transaction request directly
    const registry = new ethersLib.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, walletState.signer);
    const viewingPublicKeyBytes32 = ethersLib.utils.hexZeroPad(
      ethersLib.utils.hexlify(walletState.derivedKeys.viewingPublicKey), 
      32
    );
    
    const tx = await registry.register(walletState.mpk, viewingPublicKeyBytes32);
    
    showToast('info', '交易已提交', '等待确认...');
    await tx.wait();
    
    if (walletState.railgunWallet) {
      await walletState.railgunWallet.registerAccount(walletState.account);
    }

    walletState.isRegistered = true;
    walletState.isPrivacyEnabled = true;
    
    await refreshBalances();
    UI.updateAll(walletState);
    
    showToast('success', '隐私功能已开通', '现在可以使用隐私功能了');
    return true;
    
  } catch (error) {
    console.error('Enable privacy failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '操作已取消', '用户取消了操作');
    } else {
      showToast('error', '开通失败', error.message);
    }
    return false;
  } finally {
    walletState.isEnablingPrivacy = false;
  }
}

// Approve Token
export async function approveToken(amount = null) {
  if (!walletState.signer || !walletState.account) {
    showToast('warning', '请先连接钱包', '需要连接钱包才能授权代币');
    return false;
  }

  if (contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
    showToast('error', '合约未部署', 'TestERC20 合约未部署');
    return false;
  }

  const ethersLib = ensureEthers();

  try {
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    const approveAmount = amount 
      ? ethersLib.utils.parseEther(amount.toString())
      : ethersLib.constants.MaxUint256;
    
    showToast('info', '授权代币', '请在钱包中确认交易...');
    const approveTx = await testERC20.approve(contracts.railgun, approveAmount);
    
    showToast('info', '交易已提交', '等待确认...');
    await approveTx.wait();
    
    showToast('success', '授权成功', '代币已授权，现在可以存入隐私了');
    return true;
    
  } catch (error) {
    console.error('Approve token failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '授权失败', error.message);
    }
    return false;
  }
}

// Check Token Allowance
export async function checkTokenAllowance(requiredAmount = null) {
  if (!walletState.provider || !walletState.account) {
    return { hasAllowance: false, allowance: '0', required: requiredAmount || '0' };
  }

  if (contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
    return { hasAllowance: false, allowance: '0', required: requiredAmount || '0' };
  }

  try {
    const ethersLib = ensureEthers();
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.provider);
    const allowance = await testERC20.allowance(walletState.account, contracts.railgun);
    
    if (requiredAmount) {
      const requiredWei = ethersLib.utils.parseEther(requiredAmount.toString());
      return {
        hasAllowance: allowance.gte(requiredWei),
        allowance: ethersLib.utils.formatEther(allowance),
        required: requiredAmount
      };
    }
    
    return {
      hasAllowance: !allowance.isZero(),
      allowance: ethersLib.utils.formatEther(allowance),
      required: null
    };
  } catch (error) {
    console.warn('Check allowance failed:', error);
    return { hasAllowance: false, allowance: '0', required: requiredAmount || '0' };
  }
}

// Lookup MPK
export async function lookupMPK(address) {
  const ethersLib = ensureEthers();
  if (!address || !ethersLib.utils.isAddress(address)) {
    return null;
  }

  if (!walletState.provider || contracts.mpkRegistry === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  try {
    const registry = new ethersLib.Contract(contracts.mpkRegistry, CONFIG.MPK_REGISTRY_ABI, walletState.provider);
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
    console.error('Lookup MPK failed:', error);
    return null;
  }
}

// Transaction Management
function loadTransactions() {
  const saved = storage.get('railgun-transactions-v2', []);
  if (walletState.account) {
    walletState.transactions = saved.filter(tx => 
      !tx.account || tx.account.toLowerCase() === walletState.account.toLowerCase()
    );
  } else {
    walletState.transactions = saved;
  }
  UI.updateHistory(walletState.transactions);
}

function saveTransactions() {
  const allTxs = storage.get('railgun-transactions-v2', []);
  
  walletState.transactions.forEach(stateTx => {
    const index = allTxs.findIndex(tx => tx.txHash === stateTx.txHash);
    if (index !== -1) {
      allTxs[index] = stateTx;
    } else {
      allTxs.unshift(stateTx);
    }
  });
  
  if (allTxs.length > 100) {
    allTxs.splice(100);
  }
  
  storage.set('railgun-transactions-v2', allTxs);
}

export function addTransaction(type, title, description, amount, txHash = null, status = 'success') {
  const icons = {
    deposit: '🔐',
    withdraw: '📤',
    'transfer-public': '💳',
    'transfer-private': '🔐',
    'transfer-public-to-private': '🔐',
    'transfer-private-to-public': '💳'
  };

  walletState.transactions.unshift({
    type,
    icon: icons[type] || '📝',
    title,
    description,
    amount,
    txHash,
    status,
    time: '刚刚',
    timestamp: Date.now(),
    account: walletState.account
  });

  if (walletState.transactions.length > 50) {
    walletState.transactions = walletState.transactions.slice(0, 50);
  }

  UI.updateHistory(walletState.transactions);
  saveTransactions();
}

export function updateTransactionStatus(txHash, status, title = null, description = null) {
  const txIndex = walletState.transactions.findIndex(tx => tx.txHash === txHash);
  if (txIndex !== -1) {
    walletState.transactions[txIndex].status = status;
    if (title) walletState.transactions[txIndex].title = title;
    if (description) walletState.transactions[txIndex].description = description;
    saveTransactions();
    UI.updateHistory(walletState.transactions);
  }
}

// Setup Provider Listeners
let reconnectTimeout = null;
export function setupProviderListeners() {
  const provider = getMetaMaskProvider();
  if (!provider) return;
  
  provider.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) {
      walletState.reset();
      walletState.resetKeys();
      walletState.transactions = [];
      UI.updateAll(walletState);
      showToast('info', '钱包已断开', '请重新连接钱包');
    } else {
      const previousAccount = walletState.account;
      const newAccount = accounts[0];
      
      // If account changed, reset keys
      if (previousAccount && previousAccount.toLowerCase() !== newAccount.toLowerCase()) {
        walletState.resetKeys();
      }
      
      // Clear any pending reconnect
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      walletState.publicBalance = '0.00';
      walletState.privateBalance = '0.00';
      // Delay reconnect to avoid conflicts with ongoing connection
      reconnectTimeout = setTimeout(() => {
        if (!walletState.isConnecting) {
          connectWallet();
        }
      }, 500);
    }
  });

  provider.on('chainChanged', () => {
    // Clear any pending reconnect
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    // Delay reconnect to avoid conflicts with network switching
    reconnectTimeout = setTimeout(() => {
      if (!walletState.isConnecting) {
        connectWallet();
      }
    }, 1000);
  });
}

// Export
export { loadContractConfig };
