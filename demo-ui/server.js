#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// Server session ID (changes on every server restart)
const SERVER_SESSION_ID = Date.now().toString();

// Determine if we're in local mode
const IS_LOCAL = process.env.LOCAL === 'true';

// Broadcast configuration (dedicated broadcast account)
const DEFAULT_BROADCAST_PRIVATE_KEY = '0xd4a3fa952d8e3ad2e330f1ad6cff6ef02ddb89c146c2d3ab7e664f51b0bbaf3a';
const BROADCAST_PRIVATE_KEY = IS_LOCAL 
  ? DEFAULT_BROADCAST_PRIVATE_KEY 
  : process.env.BROADCASTER_PRIVATE_KEY;
// Default broadcast address: 0x900bd299BB71E6Dba0bCe2f985A87537F8Bc0A17
const RPC_URL = IS_LOCAL 
  ? (process.env.LOCAL_RPC || 'http://127.0.0.1:8545')
  : process.env.RPC_URL;

// Hardhat default account #0 (for funding broadcast account)
const FUNDER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MIN_BALANCE = '0.01'; // ETH
const FUND_AMOUNT = '0.1';  // ETH

// Load ethers dynamically
let ethers;
let broadcastWallet;
let provider;

async function initializeBroadcast() {
  // Validate required environment variables for online mode
  if (!IS_LOCAL) {
    if (!process.env.BROADCASTER_PRIVATE_KEY) {
      console.error('❌ Error: BROADCASTER_PRIVATE_KEY is required when LOCAL=false');
      console.error('   Please set it in .env file');
      process.exit(1);
    }
    if (!process.env.RPC_URL) {
      console.error('❌ Error: RPC_URL is required when LOCAL=false');
      console.error('   Please set it in .env file');
      process.exit(1);
    }
  }
  
  try {
    // Try to load ethers from parent project
    const ethersPath = path.join(__dirname, '..', 'node_modules', 'ethers');
    ethers = require(ethersPath);
    
    provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    broadcastWallet = new ethers.Wallet(BROADCAST_PRIVATE_KEY, provider);
    
    let balance = await provider.getBalance(broadcastWallet.address);
    
    // Auto-fund if balance is low
    if (balance.lt(ethers.utils.parseEther(MIN_BALANCE))) {
      console.log('   💰 Broadcast balance low, auto-funding...');
      const funder = new ethers.Wallet(FUNDER_PRIVATE_KEY, provider);
      const tx = await funder.sendTransaction({
        to: broadcastWallet.address,
        value: ethers.utils.parseEther(FUND_AMOUNT)
      });
      await tx.wait();
      balance = await provider.getBalance(broadcastWallet.address);
      console.log('   ✅ Funded', FUND_AMOUNT, 'ETH');
    }
    
    console.log('✅ Broadcast initialized');
    console.log('   Address:', broadcastWallet.address);
    console.log('   Balance:', ethers.utils.formatEther(balance), 'ETH');
    console.log('   RPC URL:', RPC_URL);
    if (IS_LOCAL) {
      console.log('   Mode: LOCAL (using default test account)');
    } else {
      console.log('   Mode: ONLINE (using configured private key)');
    } 
    return true;
  } catch (error) {
    console.warn('⚠️  Broadcast not available:', error.message);
    console.warn('   Broadcast API will not work until blockchain is running');
    return false;
  }
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ABIs for contract interaction
const RAILGUN_ABI = [
  'function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
  'function transact(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions) external',
  'function updateRoot() external',
  'function isRootUpdated() external view returns (bool)'
];

// Load deployments.json
function loadDeployments() {
  try {
    const deploymentsPath = path.join(__dirname, '..', 'deployments.json');
    if (fs.existsSync(deploymentsPath)) {
      return JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
    }
  } catch (error) {
    console.warn('Failed to load deployments.json:', error.message);
  }
  return null;
}

// Parse JSON body from request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Wait for transaction receipt with fallback polling
async function waitForReceipt(txHash) {
  try {
    return await provider.waitForTransaction(txHash);
  } catch (waitError) {
    // Fallback to receipt polling if RPC has issues
    if (waitError.code === 'SERVER_ERROR') {
      console.log('   Receipt polling fallback...');
      for (let i = 0; i < 60; i++) {
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        if (receipt) return receipt;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('Transaction confirmation timeout');
    }
    throw waitError;
  }
}

// Handle API requests
async function handleApiRequest(req, res, pathname) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // POST /api/broadcast - Broadcast transaction
  if (pathname === '/api/broadcast' && req.method === 'POST') {
    if (!broadcastWallet) {
      // Try to reinitialize
      await initializeBroadcast();
      if (!broadcastWallet) {
        return sendJson(res, 503, { success: false, error: 'Broadcast not available. Is blockchain running?' });
      }
    }

    try {
      const body = await parseBody(req);
      const { type, transaction } = body;

      console.log(`\n📡 Broadcast request: ${type}`);

      const deployments = loadDeployments();
      const railgunAddress = deployments && deployments.proxy;

      if (!railgunAddress) {
        return sendJson(res, 400, { success: false, error: 'deployments.json not found or proxy address not set' });
      }

      const railgun = new ethers.Contract(railgunAddress, RAILGUN_ABI, broadcastWallet);

      // Only unshield and transfer are broadcasted by server
      if (type !== 'unshield' && type !== 'transfer') {
        return sendJson(res, 400, { success: false, error: `Invalid transaction type: ${type}` });
      }

      // Check if root needs updating first
      const isRootUpdated = await railgun.isRootUpdated();
      if (!isRootUpdated) {
        console.log('   ⚠️  Root not updated, sending updateRoot first...');
        const updateRootTx = await railgun.updateRoot({ gasLimit: 700000 });
        console.log('   🔄 UpdateRoot TX sent:', updateRootTx.hash, '(will be confirmed before transact)');
        // Don't wait - next transaction will have higher nonce, ensuring updateRoot executes first
      }

      // Estimate gas
      let gasLimit;
      try {
        gasLimit = await railgun.estimateGas.transact([transaction]);
        gasLimit = gasLimit.mul(120).div(100); // Add 20% buffer
      } catch (e) {
        console.warn('Gas estimation failed:', e.message);
        gasLimit = ethers.BigNumber.from(1000000);
      }

      // Execute transact transaction
      console.log(`   Executing ${type}...`);
      const tx = await railgun.transact([transaction], { gasLimit });
      console.log('   TX Hash:', tx.hash);

      // Return txHash immediately to frontend (don't wait for anything)
      sendJson(res, 200, {
        success: true,
        txHash: tx.hash,
        pending: true
      });

      // Wait for confirmation in background (for logging only)
      console.log('   Waiting for confirmation...');
      waitForReceipt(tx.hash).then(receipt => {
        console.log(`   ✅ ${type} confirmed in block:`, receipt.blockNumber);
      }).catch(error => {
        console.error(`   ❌ ${type} confirmation failed:`, error.message);
      });
      
      return;

    } catch (error) {
      console.error('   ❌ Broadcast failed:', error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  // GET /api/session - Get server session ID (changes on restart)
  if (pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, { sessionId: SERVER_SESSION_ID });
  }

  // GET /api/network-config - Get network configuration
  if (pathname === '/api/network-config' && req.method === 'GET') {
    const networkConfig = {
      isLocal: IS_LOCAL,
      rpcUrl: RPC_URL,
      chainId: IS_LOCAL ? 1337 : parseInt(process.env.CHAIN_ID),
      chainName: IS_LOCAL ? 'Hardhat Local' : 'Online Network',
      blockExplorerUrl: IS_LOCAL ? '' : (process.env.BLOCK_EXPLORER_URL || ''),
    };
    return sendJson(res, 200, networkConfig);
  }

  // GET /api/broadcast-status - Get broadcast service info
  if (pathname === '/api/broadcast-status' && req.method === 'GET') {
    if (!broadcastWallet) {
      return sendJson(res, 503, { available: false, error: 'Broadcast not initialized' });
    }

    try {
      const balance = await provider.getBalance(broadcastWallet.address);
      return sendJson(res, 200, {
        available: true,
        address: broadcastWallet.address,
        balance: ethers.utils.formatEther(balance)
      });
    } catch (error) {
      return sendJson(res, 500, { available: false, error: error.message });
    }
  }

  // POST /api/update-root - Update Merkle root (for shield transactions)
  if (pathname === '/api/update-root' && req.method === 'POST') {
    if (!broadcastWallet) {
      // Try to reinitialize
      await initializeBroadcast();
      if (!broadcastWallet) {
        return sendJson(res, 503, { success: false, error: 'Broadcast not available. Is blockchain running?' });
      }
    }

    try {
      console.log('\n🔄 Update root request');

      const deployments = loadDeployments();
      const railgunAddress = deployments && deployments.proxy;

      if (!railgunAddress) {
        return sendJson(res, 400, { success: false, error: 'deployments.json not found or proxy address not set' });
      }

      const railgun = new ethers.Contract(railgunAddress, RAILGUN_ABI, broadcastWallet);

      console.log('   Sending updateRoot...');
      const updateRootTx = await railgun.updateRoot({ gasLimit: 700000 });
      console.log('   UpdateRoot TX sent:', updateRootTx.hash);
      
      // Wait for confirmation before returning (ensures root is updated)
      console.log('   Waiting for confirmation...');
      const receipt = await waitForReceipt(updateRootTx.hash);
      console.log('   ✅ Root updated in block:', receipt.blockNumber);

      return sendJson(res, 200, {
        success: true,
        txHash: updateRootTx.hash,
        blockNumber: receipt.blockNumber
      });

    } catch (error) {
      console.error('   ❌ Update root failed:', error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  // Unknown API endpoint
  sendJson(res, 404, { error: 'API endpoint not found' });
}

// Main HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  console.log(`${req.method} ${pathname}`);

  // Handle API requests
  if (pathname.startsWith('/api/')) {
    return handleApiRequest(req, res, pathname);
  }

  // Serve static files
  let filePath;

  if (pathname === '/deployments.json') {
    filePath = path.join(__dirname, '..', 'deployments.json');
  } else {
    filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        console.log(`  ❌ File not found: ${filePath}`);
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        console.log(`  ❌ Server error: ${error.code}`);
        res.writeHead(500);
        res.end('Server Error: ' + error.code + '\n');
      }
    } else {
      console.log(`  ✅ ${filePath}`);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content, 'utf-8');
    }
  });
});

// Start server
server.listen(PORT, async () => {
  console.log('\n🚂 Railgun Privacy Wallet Demo');
  console.log('================================');
  console.log(`✅ Server running at http://localhost:${PORT}/`);
  console.log(`📡 Session ID: ${SERVER_SESSION_ID}`);
  console.log('\n📡 Initializing broadcast service...');
  
  await initializeBroadcast();
  
  console.log('\n🔗 API Endpoints:');
  console.log('   POST /api/broadcast        - Broadcast transaction');
  console.log('   POST /api/update-root      - Update Merkle root');
  console.log('   GET  /api/broadcast-status - Get broadcast service status');
  console.log('   GET  /api/session          - Get server session ID');
  console.log('   GET  /api/network-config   - Get network configuration');
  console.log('\nPress Ctrl+C to stop\n');
});
