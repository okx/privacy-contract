// Configuration Management
export const CONFIG = {
  // TARGET_CHAIN will be loaded dynamically from server
  TARGET_CHAIN: {
    chainId: null,     // Will be loaded from /api/network-config
    chainName: null,   // Will be loaded from /api/network-config
    rpcUrl: null,      // Will be loaded from /api/network-config
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18
    },
    blockExplorerUrl: ''
  },

  MPK_REGISTRY_ABI: [
    'function register(bytes32 mpk, bytes32 viewingPublicKey) external',
    'function getUserInfo(address user) external view returns (bytes32 mpk, bytes32 viewingPublicKey)',
    'function users(address) external view returns (bytes32 mpk, bytes32 viewingPublicKey)'
  ],

  RAILGUN_ABI: [
    'function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
    'function transact(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions) external',
    'function testERC20() external view returns (address)',
    'function isRootUpdated() external view returns (bool)',
    'event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)',
    'event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext)',
    'event Nullified(uint16 treeNumber, bytes32[] nullifier)',
    'event Unshield(address to, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)'
  ],

  TEST_ERC20_ABI: [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function symbol() external view returns (string)',
    'function name() external view returns (string)',
    'function decimals() external view returns (uint8)'
  ]
};

// Contract addresses (will be loaded from deployments.json)
export const contracts = {
  mpkRegistry: '0x0000000000000000000000000000000000000000',
  railgun: '0x0000000000000000000000000000000000000000',
  testERC20: '0x0000000000000000000000000000000000000000'
};

// ERC20 token info
export const erc20TokenInfo = {
  address: null,
  symbol: 'TOKEN',
  name: 'Test Token',
  decimals: 18
};

// Load network configuration from server
async function loadNetworkConfig() {
  try {
    const response = await fetch('/api/network-config');
    if (response.ok) {
      const networkConfig = await response.json();
      
      CONFIG.TARGET_CHAIN.chainId = networkConfig.chainId;
      CONFIG.TARGET_CHAIN.chainName = networkConfig.chainName;
      CONFIG.TARGET_CHAIN.rpcUrl = networkConfig.rpcUrl;
      CONFIG.TARGET_CHAIN.blockExplorerUrl = networkConfig.blockExplorerUrl || '';
      
      console.log('✅ Network configuration loaded:');
      console.log('  Chain ID:', networkConfig.chainId);
      console.log('  Chain Name:', networkConfig.chainName);
      console.log('  RPC URL:', networkConfig.rpcUrl);
      console.log('  Block Explorer:', networkConfig.blockExplorerUrl || 'Not configured');
      console.log('  Mode:', networkConfig.isLocal ? 'LOCAL' : 'ONLINE');
      
      return true;
    } else {
      console.warn('⚠️ Failed to load network config');
      return false;
    }
  } catch (error) {
    console.warn('⚠️ Failed to load network config:', error.message);
    return false;
  }
}

// Load contract configuration from deployments.json
export async function loadContractConfig() {
  try {
    // First, load network configuration
    await loadNetworkConfig();
    
    // Then check if server session changed (server restarted)
    const { storage } = await import('./utils.js');
    await checkServerSession(storage);
    
    const response = await fetch('/deployments.json');
    if (response.ok) {
      const config = await response.json();
      
      contracts.railgun = config.proxy || contracts.railgun;
      contracts.testERC20 = config.testERC20 || contracts.testERC20;
      contracts.mpkRegistry = config.mpkRegistry || contracts.mpkRegistry;
      
      if (contracts.testERC20 !== '0x0000000000000000000000000000000000000000') {
        erc20TokenInfo.address = contracts.testERC20;
      }
      
      console.log('✅ Configuration loaded:');
      console.log('  RailgunSmartWallet:', contracts.railgun);
      console.log('  TestERC20:', contracts.testERC20);
      console.log('  MPKRegistry:', contracts.mpkRegistry);
      
      return true;
    } else {
      console.warn('⚠️ deployments.json not found');
      return false;
    }
  } catch (error) {
    console.warn('⚠️ Failed to load deployments.json:', error.message);
    return false;
  }
}

// Check if server session changed (server restarted = clear all data)
async function checkServerSession(storage) {
  try {
    const response = await fetch('/api/session');
    if (response.ok) {
      const { sessionId } = await response.json();
      const savedSessionId = storage.get('railgun-server-session');
      
      console.log('📡 Server session check:');
      console.log('   Current server session:', sessionId);
      console.log('   Saved session:', savedSessionId);
      
      // Clear data if: no saved session (first load after restart) OR session changed
      if (!savedSessionId || savedSessionId !== sessionId) {
        console.log('🧹 Clearing all localStorage data (new session detected)...');
        
        // List all keys before clearing
        const allKeys = Object.keys(localStorage);
        const railgunKeys = allKeys.filter(k => k.includes('railgun'));
        console.log('   Keys to clear:', railgunKeys);
        
        storage.clearAll();
        
        // Verify cleared
        const remainingKeys = Object.keys(localStorage).filter(k => k.includes('railgun'));
        console.log('   Remaining keys:', remainingKeys);
      } else {
        console.log('   ✅ Same session, keeping data');
      }
      
      storage.set('railgun-server-session', sessionId);
    }
  } catch (error) {
    console.warn('Failed to check server session:', error.message);
  }
}
