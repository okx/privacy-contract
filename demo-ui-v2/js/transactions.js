// 交易功能模块
import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, validateAmount, showToast, formatAddress } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances, lookupMPK } from './wallet.js';
import * as UI from './ui.js';

const SIGNATURE_MESSAGE = 'Railgun Spendingkey';

// 请求签名确认
async function requestSignatureConfirmation() {
  const ethersLib = ensureEthers();
  
  const signature = await walletState.signer.signMessage(SIGNATURE_MESSAGE);
  const keys = await walletState.railgunWallet.generateKeys(walletState.account, signature);
  
  const derivedSpendingKey = '0x' + keys.spendingKey;
  const storedSpendingKey = ethersLib.utils.hexlify(walletState.derivedKeys.spendingKey);
  
  if (derivedSpendingKey.toLowerCase() !== storedSpendingKey.toLowerCase()) {
    throw new Error('密钥不匹配！钱包可能已更换。请重新连接。');
  }
  
  return keys;
}

// 广播交易
async function broadcast(type, transaction) {
  const response = await fetch('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, transaction })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || '广播失败');
  }
  return result;
}

// 请求更新 Merkle root
function requestUpdateRoot() {
  fetch('/api/update-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(response => response.json())
    .then(result => {
      if (result.success) {
        console.log('✅ Merkle root 更新已请求');
      }
    })
    .catch(() => {});
}

// 格式化交易数据
function formatTransactionForContract(transaction) {
  const ethersLib = ensureEthers();
  
  const proof = {
    a: {
      x: transaction.proof.a.x.toString(),
      y: transaction.proof.a.y.toString(),
    },
    b: {
      x: transaction.proof.b.x.map(v => v.toString()),
      y: transaction.proof.b.y.map(v => v.toString()),
    },
    c: {
      x: transaction.proof.c.x.toString(),
      y: transaction.proof.c.y.toString(),
    },
  };

  const boundParams = {
    treeNumber: transaction.boundParams.treeNumber,
    minGasPrice: transaction.boundParams.minGasPrice.toString(),
    unshield: transaction.boundParams.unshield,
    chainID: transaction.boundParams.chainID.toString(),
    adaptContract: transaction.boundParams.adaptContract,
    adaptParams: ethersLib.utils.hexlify(transaction.boundParams.adaptParams),
    commitmentCiphertext: transaction.boundParams.commitmentCiphertext.map(ct => ({
      ciphertext: ct.ciphertext.map(c => ethersLib.utils.hexlify(c)),
      blindedSenderViewingKey: ethersLib.utils.hexlify(ct.blindedSenderViewingKey),
      blindedReceiverViewingKey: ethersLib.utils.hexlify(ct.blindedReceiverViewingKey),
      annotationData: ethersLib.utils.hexlify(ct.annotationData),
      memo: ethersLib.utils.hexlify(ct.memo),
    })),
  };

  const unshieldPreimage = {
    npk: ethersLib.utils.hexlify(transaction.unshieldPreimage.npk),
    token: {
      tokenType: transaction.unshieldPreimage.token.tokenType,
      tokenAddress: transaction.unshieldPreimage.token.tokenAddress,
      tokenSubID: transaction.unshieldPreimage.token.tokenSubID.toString(),
    },
    value: transaction.unshieldPreimage.value.toString(),
  };

  return {
    proof,
    merkleRoot: ethersLib.utils.hexlify(transaction.merkleRoot),
    nullifiers: transaction.nullifiers.map(n => ethersLib.utils.hexlify(n)),
    commitments: transaction.commitments.map(c => ethersLib.utils.hexlify(c)),
    boundParams,
    unshieldPreimage,
  };
}

// 存入隐私余额（Shield）
export async function handleDeposit(amountValue) {
  console.log('存入隐私余额, 金额:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    showToast('error', '钱包未连接', '请先连接钱包');
    return;
  }

  if (!walletState.isPrivacyEnabled) {
    showToast('error', '隐私未启用', '请先启用隐私交易');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    showToast('error', '金额无效', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#convert-action-btn', true, '存入中...');
  let depositTx = null;

  try {
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
    // 检查余额
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    const balance = await testERC20.balanceOf(walletState.account);

    if (balance.lt(amountWei)) {
      showToast('error', '余额不足', `公开余额不足，当前: ${ethersLib.utils.formatEther(balance)}`);
      return;
    }

    // 创建 Shield 请求
    const shieldRequestRaw = await walletState.railgunWallet.createShieldRequest(
      walletState.account,
      amountWei.toString(),
      contracts.testERC20,
      0,
      0n
    );
    
    const shieldRequest = {
      preimage: {
        npk: shieldRequestRaw.preimage.npk instanceof Uint8Array
          ? ethersLib.utils.hexZeroPad(ethersLib.utils.hexlify(shieldRequestRaw.preimage.npk), 32)
          : ethersLib.utils.hexZeroPad(shieldRequestRaw.preimage.npk, 32),
        token: {
          tokenType: shieldRequestRaw.preimage.token.tokenType,
          tokenAddress: shieldRequestRaw.preimage.token.tokenAddress,
          tokenSubID: ethersLib.BigNumber.from(shieldRequestRaw.preimage.token.tokenSubID.toString())
        },
        value: ethersLib.BigNumber.from(shieldRequestRaw.preimage.value.toString())
      },
      ciphertext: {
        encryptedBundle: shieldRequestRaw.ciphertext.encryptedBundle.map(bundle =>
          bundle instanceof Uint8Array 
            ? ethersLib.utils.hexZeroPad(ethersLib.utils.hexlify(bundle), 32)
            : ethersLib.utils.hexZeroPad(bundle, 32)
        ),
        shieldKey: shieldRequestRaw.ciphertext.shieldKey instanceof Uint8Array
          ? ethersLib.utils.hexZeroPad(ethersLib.utils.hexlify(shieldRequestRaw.ciphertext.shieldKey), 32)
          : ethersLib.utils.hexZeroPad(shieldRequestRaw.ciphertext.shieldKey, 32)
      }
    };

    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    
    let gasLimit;
    try {
      const estimatedGas = await railgun.estimateGas.shield([shieldRequest]);
      gasLimit = estimatedGas.mul(120).div(100);
    } catch {
      gasLimit = ethersLib.BigNumber.from(2000000);
    }

    depositTx = await railgun.shield([shieldRequest], { gasLimit });
    
    addTransaction('deposit', '存入隐私', `存入 ${amountValue} ${erc20TokenInfo.symbol}`, `+${amountValue} ${erc20TokenInfo.symbol}`, depositTx.hash, 'pending');
    showToast('info', '交易已提交', '等待确认...');
    
    requestUpdateRoot();
    
    const receipt = await depositTx.wait();

    updateTransactionStatus(depositTx.hash, 'success', '存入隐私', `已存入 ${amountValue} ${erc20TokenInfo.symbol}`);
    showToast('success', '存入成功', `${amountValue} ${erc20TokenInfo.symbol} 已存入隐私余额`);
    
    // 交易成功后自动关闭 Modal
    const convertModal = document.getElementById('convert-modal');
    if (convertModal) convertModal.style.display = 'none';
    
    // 后台扫描更新余额
    (async () => {
      try {
        await walletState.railgunWallet.registerAccount(walletState.account);
        await walletState.railgunWallet.scanTransaction(depositTx.hash, walletState.account);
        
        const privateBalance = await walletState.railgunWallet.getBalance(
          walletState.account,
          contracts.testERC20,
          0
        );
        walletState.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);
        
        await refreshBalances();
      } catch (scanError) {
        console.warn('后台扫描失败:', scanError.message);
      }
    })();

  } catch (error) {
    console.error('存入失败:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '存入失败', error.message);
    }
    
    if (depositTx?.hash) {
      updateTransactionStatus(depositTx.hash, 'failed', '存入失败', `存入 ${amountValue} ${erc20TokenInfo.symbol} 失败`);
    }
  } finally {
    UI.setButtonLoading('#convert-action-btn', false);
  }
}

// 提取公开余额（Unshield）
export async function handleWithdraw(amountValue) {
  console.log('提取公开余额, 金额:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    showToast('error', '钱包未连接', '请先连接钱包');
    return;
  }

  if (!walletState.isPrivacyEnabled) {
    showToast('error', '隐私未启用', '请先启用隐私交易');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    showToast('error', '金额无效', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  
  // 检查隐私余额
  const amountWei = ethersLib.utils.parseEther(amountValue);
  const privateBalance = await walletState.railgunWallet.getBalance(
    walletState.account,
    contracts.testERC20,
    0
  );
  
  if (privateBalance < amountWei.toBigInt()) {
    showToast('error', '余额不足', `隐私余额不足，当前: ${ethersLib.utils.formatEther(privateBalance)}`);
    return;
  }

  UI.setButtonLoading('#convert-action-btn', true, '请签名确认...');

  try {
    await requestSignatureConfirmation();
    
    UI.setButtonLoading('#convert-action-btn', true, '准备交易...');
    
    const unshieldData = await walletState.railgunWallet.prepareUnshieldTransaction(
      walletState.account,
      amountWei.toString(),
      walletState.account,
      contracts.testERC20,
      0,
      0n,
      undefined,
      2
    );

    const network = await walletState.provider.getNetwork();
    const chainID = BigInt(network.chainId);

    const transaction = await walletState.railgunWallet.formatTransactionForContract(
      walletState.account,
      unshieldData.inputNotes,
      unshieldData.outputNotes,
      chainID,
      0n,
      '0x0000000000000000000000000000000000000000',
      new Uint8Array(32),
      unshieldData.inputUTXOs,
    );

    const formattedTransaction = formatTransactionForContract(transaction);

    UI.setButtonLoading('#convert-action-btn', true, '广播中...');
    showToast('info', '交易已提交', '等待确认...');
    
    const result = await broadcast('unshield', formattedTransaction);
    
    addTransaction('withdraw', '提取公开', `提取 ${amountValue} ${erc20TokenInfo.symbol}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');
    showToast('success', '提取成功', `${amountValue} ${erc20TokenInfo.symbol} 已提取到公开余额`);

    // 交易成功后自动关闭 Modal
    const convertModal = document.getElementById('convert-modal');
    if (convertModal) convertModal.style.display = 'none';

    // 后台扫描更新余额
    (async () => {
      try {
        await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
        await refreshBalances();
      } catch (scanError) {
        console.warn('后台扫描失败:', scanError.message);
      }
    })();

  } catch (error) {
    console.error('提取失败:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了签名');
    } else {
      showToast('error', '提取失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#convert-action-btn', false);
  }
}

// 公开转账
export async function handlePublicTransfer(recipientAddress, amountValue) {
  console.log('公开转账, 收款方:', recipientAddress, '金额:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    showToast('error', '钱包未连接', '请先连接钱包');
    return;
  }

  const ethersLib = ensureEthers();
  
  if (!ethersLib.utils.isAddress(recipientAddress)) {
    showToast('error', '地址无效', '请输入有效的收款地址');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    showToast('error', '金额无效', error.message);
    return;
  }

  const amountWei = ethersLib.utils.parseEther(amountValue);
  
  // 检查余额
  const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
  const balance = await testERC20.balanceOf(walletState.account);
  
  if (balance.lt(amountWei)) {
    showToast('error', '余额不足', `公开余额不足，当前: ${ethersLib.utils.formatEther(balance)}`);
    return;
  }

  UI.setButtonLoading('#transfer-btn', true, '转账中...');

  try {
    const tx = await testERC20.transfer(recipientAddress, amountWei);
    
    addTransaction('transfer-public', '公开转账', `转给 ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, tx.hash, 'pending');
    showToast('info', '交易已提交', '等待确认...');
    
    await tx.wait();
    
    updateTransactionStatus(tx.hash, 'success', '公开转账', `转给 ${formatAddress(recipientAddress)}`);
    showToast('success', '转账成功', `${amountValue} ${erc20TokenInfo.symbol} 已转给 ${formatAddress(recipientAddress)}`);
    
    // 转账成功后清空输入框
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
    
    await refreshBalances();

  } catch (error) {
    console.error('公开转账失败:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}

// 隐私转账
export async function handlePrivateTransfer(recipientAddress, amountValue) {
  console.log('隐私转账, 收款方:', recipientAddress, '金额:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    showToast('error', '钱包未连接', '请先连接钱包');
    return;
  }

  if (!walletState.isPrivacyEnabled) {
    showToast('error', '隐私未启用', '请先启用隐私交易');
    return;
  }

  const ethersLib = ensureEthers();
  
  if (!ethersLib.utils.isAddress(recipientAddress)) {
    showToast('error', '地址无效', '请输入有效的收款地址');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    showToast('error', '金额无效', error.message);
    return;
  }

  // 查询收款方 MPK
  const userInfo = await lookupMPK(recipientAddress);
  
  if (!userInfo) {
    showToast('error', '收款方未注册', '收款方尚未启用隐私交易，无法进行隐私转账');
    return;
  }

  const amountWei = ethersLib.utils.parseEther(amountValue);
  const privateBalance = await walletState.railgunWallet.getBalance(
    walletState.account,
    contracts.testERC20,
    0
  );
  
  if (privateBalance < amountWei.toBigInt()) {
    showToast('error', '余额不足', `隐私余额不足，当前: ${ethersLib.utils.formatEther(privateBalance)}`);
    return;
  }

  UI.setButtonLoading('#transfer-btn', true, '请签名确认...');

  try {
    await requestSignatureConfirmation();
    
    UI.setButtonLoading('#transfer-btn', true, '准备交易...');

    const transferData = await walletState.railgunWallet.prepareTransferTransaction(
      walletState.account,
      amountWei.toString(),
      recipientAddress,
      userInfo.viewingPublicKey,
      contracts.testERC20,
      0,
      0n,
      undefined,
      2
    );

    const network = await walletState.provider.getNetwork();
    const chainID = BigInt(network.chainId);

    const transaction = await walletState.railgunWallet.formatTransferTransactionForContract(
      walletState.account,
      transferData.inputNotes,
      transferData.outputNotes,
      userInfo.mpk,
      userInfo.viewingPublicKey,
      chainID,
      0n,
      '0x0000000000000000000000000000000000000000',
      new Uint8Array(32),
      transferData.inputUTXOs,
    );

    const formattedTransaction = formatTransactionForContract(transaction);

    UI.setButtonLoading('#transfer-btn', true, '广播中...');
    showToast('info', '交易已提交', '等待确认...');
    
    const result = await broadcast('transfer', formattedTransaction);
    
    addTransaction('transfer-private', '隐私转账', `转给 ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');
    showToast('success', '转账成功', `${amountValue} ${erc20TokenInfo.symbol} 已私密转给 ${formatAddress(recipientAddress)}`);

    // 转账成功后清空输入框
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));

    // 后台扫描更新余额
    (async () => {
      try {
        await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
        await walletState.railgunWallet.scanTransaction(result.txHash, recipientAddress, [{
          tokenType: 0,
          tokenAddress: contracts.testERC20,
          tokenSubID: 0n,
        }]);
        await refreshBalances();
      } catch (scanError) {
        console.warn('后台扫描失败:', scanError.message);
      }
    })();

  } catch (error) {
    console.error('隐私转账失败:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了签名');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}
