#!/usr/bin/env node

// 从 .env 文件加载环境变量
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001; // 使用 3001 端口，避免与 v1 冲突

// 服务器会话 ID（每次重启时变化）
const SERVER_SESSION_ID = Date.now().toString();

// 判断是否为本地模式
const IS_LOCAL = process.env.LOCAL === 'true';

// 广播配置
const DEFAULT_BROADCAST_PRIVATE_KEY = '0xd4a3fa952d8e3ad2e330f1ad6cff6ef02ddb89c146c2d3ab7e664f51b0bbaf3a';
const BROADCAST_PRIVATE_KEY = IS_LOCAL 
  ? DEFAULT_BROADCAST_PRIVATE_KEY 
  : process.env.BROADCASTER_PRIVATE_KEY;
const RPC_URL = IS_LOCAL 
  ? (process.env.LOCAL_RPC || 'http://127.0.0.1:8545')
  : process.env.RPC_URL;

// Hardhat 默认账户 #0（用于给广播账户充值）
const FUNDER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MIN_BALANCE = '0.01';
const FUND_AMOUNT = '0.1';

let ethers;
let broadcastWallet;
let provider;

async function initializeBroadcast() {
  if (!IS_LOCAL) {
    if (!process.env.BROADCASTER_PRIVATE_KEY) {
      console.error('❌ 错误: 在线模式需要 BROADCASTER_PRIVATE_KEY');
      process.exit(1);
    }
    if (!process.env.RPC_URL) {
      console.error('❌ 错误: 在线模式需要 RPC_URL');
      process.exit(1);
    }
  }
  
  try {
    const ethersPath = path.join(__dirname, '..', 'node_modules', 'ethers');
    ethers = require(ethersPath);
    
    provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    broadcastWallet = new ethers.Wallet(BROADCAST_PRIVATE_KEY, provider);
    
    let balance = await provider.getBalance(broadcastWallet.address);
    
    if (balance.lt(ethers.utils.parseEther(MIN_BALANCE))) {
      console.log('   💰 广播账户余额不足，自动充值...');
      const funder = new ethers.Wallet(FUNDER_PRIVATE_KEY, provider);
      const tx = await funder.sendTransaction({
        to: broadcastWallet.address,
        value: ethers.utils.parseEther(FUND_AMOUNT)
      });
      await tx.wait();
      balance = await provider.getBalance(broadcastWallet.address);
      console.log('   ✅ 已充值', FUND_AMOUNT, 'ETH');
    }
    
    console.log('✅ 广播服务已初始化');
    console.log('   地址:', broadcastWallet.address);
    console.log('   余额:', ethers.utils.formatEther(balance), 'ETH');
    console.log('   RPC:', RPC_URL);
    console.log('   模式:', IS_LOCAL ? '本地' : '在线');
    return true;
  } catch (error) {
    console.warn('⚠️ 广播服务不可用:', error.message);
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

const RAILGUN_ABI = [
  'function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
  'function transact(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions) external',
  'function updateRoot() external'
];

function loadDeployments() {
  try {
    const deploymentsPath = path.join(__dirname, '..', 'deployments.json');
    if (fs.existsSync(deploymentsPath)) {
      return JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
    }
  } catch (error) {
    console.warn('加载 deployments.json 失败:', error.message);
  }
  return null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('无效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

async function handleApiRequest(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // POST /api/broadcast - 广播交易
  if (pathname === '/api/broadcast' && req.method === 'POST') {
    if (!broadcastWallet) {
      await initializeBroadcast();
      if (!broadcastWallet) {
        return sendJson(res, 503, { success: false, error: '广播服务不可用' });
      }
    }

    try {
      const body = await parseBody(req);
      const { type, transaction } = body;

      console.log(`\n📡 广播请求: ${type}`);

      const deployments = loadDeployments();
      const railgunAddress = deployments && deployments.proxy;

      if (!railgunAddress) {
        return sendJson(res, 400, { success: false, error: '未找到 deployments.json' });
      }

      const railgun = new ethers.Contract(railgunAddress, RAILGUN_ABI, broadcastWallet);

      let tx;
      let gasLimit;

      if (type === 'shield') {
        try {
          gasLimit = await railgun.estimateGas.shield([transaction]);
          gasLimit = gasLimit.mul(120).div(100);
        } catch (e) {
          gasLimit = ethers.BigNumber.from(10000000);
        }

        console.log('   执行 shield...');
        tx = await railgun.shield([transaction], { gasLimit });

      } else if (type === 'unshield' || type === 'transfer') {
        try {
          gasLimit = await railgun.estimateGas.transact([transaction]);
          gasLimit = gasLimit.mul(120).div(100);
        } catch (e) {
          gasLimit = ethers.BigNumber.from(10000000);
        }

        console.log(`   执行 ${type}...`);
        tx = await railgun.transact([transaction], { gasLimit });

      } else {
        return sendJson(res, 400, { success: false, error: `未知交易类型: ${type}` });
      }

      console.log('   交易哈希:', tx.hash);

      // 后台更新 root
      railgun.updateRoot({ gasLimit: 700000 })
        .then(updateRootTx => {
          console.log('   🔄 UpdateRoot 已发送:', updateRootTx.hash);
          return updateRootTx.wait();
        })
        .then(() => {
          console.log('   ✅ Root 已更新');
        })
        .catch(updateError => {
          console.warn('   ⚠️ Root 更新失败:', updateError.message);
        });

      console.log('   等待确认...');
      let receipt;
      try {
        receipt = await tx.wait();
      } catch (waitError) {
        if (waitError.code === 'SERVER_ERROR') {
          let attempts = 0;
          while (!receipt && attempts < 60) {
            try {
              receipt = await provider.getTransactionReceipt(tx.hash);
              if (receipt) break;
            } catch (err) {}
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
          }
          if (!receipt) {
            throw new Error('交易确认超时');
          }
        } else {
          throw waitError;
        }
      }
      console.log(`   ✅ ${type} 已确认，区块:`, receipt.blockNumber);

      return sendJson(res, 200, {
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber
      });

    } catch (error) {
      console.error('   ❌ 广播失败:', error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  // GET /api/session
  if (pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, { sessionId: SERVER_SESSION_ID });
  }

  // GET /api/network-config
  if (pathname === '/api/network-config' && req.method === 'GET') {
    const networkConfig = {
      isLocal: IS_LOCAL,
      rpcUrl: RPC_URL,
      chainId: IS_LOCAL ? 1337 : parseInt(process.env.CHAIN_ID),
      chainName: IS_LOCAL ? 'Hardhat 本地网络' : '在线网络',
      blockExplorerUrl: IS_LOCAL ? '' : (process.env.BLOCK_EXPLORER_URL || ''),
    };
    return sendJson(res, 200, networkConfig);
  }

  // GET /api/broadcast-status
  if (pathname === '/api/broadcast-status' && req.method === 'GET') {
    if (!broadcastWallet) {
      return sendJson(res, 503, { available: false, error: '广播服务未初始化' });
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

  // POST /api/update-root
  if (pathname === '/api/update-root' && req.method === 'POST') {
    if (!broadcastWallet) {
      await initializeBroadcast();
      if (!broadcastWallet) {
        return sendJson(res, 503, { success: false, error: '广播服务不可用' });
      }
    }

    try {
      console.log('\n🔄 更新 root 请求');

      const deployments = loadDeployments();
      const railgunAddress = deployments && deployments.proxy;

      if (!railgunAddress) {
        return sendJson(res, 400, { success: false, error: '未找到 deployments.json' });
      }

      const railgun = new ethers.Contract(railgunAddress, RAILGUN_ABI, broadcastWallet);

      const updateRootTx = await railgun.updateRoot({ gasLimit: 700000 });
      console.log('   🔄 UpdateRoot 已发送:', updateRootTx.hash);
      
      // 后台等待确认
      (async () => {
        try {
          await updateRootTx.wait();
          console.log('   ✅ Root 已更新');
        } catch (waitError) {
          console.warn('   ⚠️ Root 更新确认失败:', waitError.message);
        }
      })();

      return sendJson(res, 200, {
        success: true,
        txHash: updateRootTx.hash
      });

    } catch (error) {
      console.error('   ❌ 更新 root 失败:', error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  sendJson(res, 404, { error: 'API 端点未找到' });
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  console.log(`${req.method} ${pathname}`);

  // API 请求
  if (pathname.startsWith('/api/')) {
    return handleApiRequest(req, res, pathname);
  }

  // 静态文件
  let filePath;

  if (pathname === '/deployments.json') {
    filePath = path.join(__dirname, '..', 'deployments.json');
  } else if (pathname === '/railgun-wallet-bundle.js' || pathname === '/railgun-wallet-bundle.js.map') {
    // 从 demo-ui 加载 bundle
    filePath = path.join(__dirname, '..', 'demo-ui', pathname);
  } else {
    filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        console.log(`  ❌ 文件未找到: ${filePath}`);
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 未找到</h1>', 'utf-8');
      } else {
        console.log(`  ❌ 服务器错误: ${error.code}`);
        res.writeHead(500);
        res.end('服务器错误: ' + error.code + '\n');
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

// 启动服务器
server.listen(PORT, async () => {
  console.log('\n🔒 隐私钱包 v2');
  console.log('================================');
  console.log(`✅ 服务器运行在 http://localhost:${PORT}/`);
  console.log(`📡 会话 ID: ${SERVER_SESSION_ID}`);
  console.log('\n📡 正在初始化广播服务...');
  
  await initializeBroadcast();
  
  console.log('\n🔗 API 端点:');
  console.log('   POST /api/broadcast        - 广播交易');
  console.log('   POST /api/update-root      - 更新 Merkle root');
  console.log('   GET  /api/broadcast-status - 获取广播服务状态');
  console.log('   GET  /api/session          - 获取会话 ID');
  console.log('   GET  /api/network-config   - 获取网络配置');
  console.log('\n按 Ctrl+C 停止服务\n');
});
