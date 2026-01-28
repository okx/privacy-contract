// Transaction Module
import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, validateAmount, showToast, formatAddress } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances, lookupMPK, approveToken, checkTokenAllowance } from './wallet.js';
import * as UI from './ui.js';

const SIGNATURE_MESSAGE = 'Railgun Spendingkey';

// Update deposit button to show approve or deposit based on allowance
export async function updateDepositButtonForApproval(amountValue) {
  const btn = document.getElementById('convert-action-btn');
  if (!btn) return;
  
  const allowanceInfo = await checkTokenAllowance(amountValue);
  
  if (!allowanceInfo.hasAllowance) {
    // Show approve button
    btn.className = 'modal-single-action-btn approve';
    btn.innerHTML = '<span class="btn-text">授权代币</span><span class="btn-arrow">→</span>';
    btn.disabled = !walletState.account || !walletState.isPrivacyEnabled;
    btn.dataset.action = 'approve';
    btn.dataset.amount = amountValue;
  } else {
    // Show deposit button
    btn.className = 'modal-single-action-btn deposit';
    btn.innerHTML = '<span class="btn-text">存入隐私</span><span class="btn-arrow">→</span>';
    btn.disabled = !walletState.account || !walletState.isPrivacyEnabled || parseFloat(walletState.publicBalance) <= 0;
    btn.dataset.action = 'deposit';
  }
}

// Request signature confirmation (only if keys not cached)
async function requestSignatureConfirmation() {
  const ethersLib = ensureEthers();
  
  // First, try to load keys from cache
  const savedKeys = await walletState.railgunWallet.loadKeys(walletState.account);
  
  let keys;
  if (savedKeys && savedKeys.spendingKey && savedKeys.viewingKey) {
    // Use cached keys
    console.log('✅ Using cached keys for signature confirmation');
    keys = {
      spendingKey: savedKeys.spendingKey,
      viewingKey: savedKeys.viewingKey,
    };
    
    // Restore walletState.derivedKeys if they're missing (e.g., after page refresh)
    if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
      console.log('🔄 Restoring walletState.derivedKeys from cached keys...');
      walletState.derivedKeys.spendingKey = ethersLib.utils.arrayify('0x' + keys.spendingKey);
      walletState.derivedKeys.viewingKey = ethersLib.utils.arrayify('0x' + keys.viewingKey);
      
      // Also restore viewingPublicKey and mpk if needed
      if (!walletState.derivedKeys.viewingPublicKey) {
        walletState.derivedKeys.viewingPublicKey = await walletState.railgunWallet.getViewingPublicKey(keys.viewingKey);
      }
      if (!walletState.mpk) {
        const mpkBytes = await walletState.railgunWallet.getMPK(keys.spendingKey, keys.viewingKey);
        walletState.mpk = ethersLib.utils.hexlify(mpkBytes);
      }
    } else {
      // Verify keys match stored keys in walletState
      const cachedSpendingKey = '0x' + keys.spendingKey;
      const storedSpendingKey = ethersLib.utils.hexlify(walletState.derivedKeys.spendingKey);
      
      if (cachedSpendingKey.toLowerCase() !== storedSpendingKey.toLowerCase()) {
        console.warn('⚠️ Cached keys do not match walletState, requesting new signature...');
        // Keys don't match, need to request signature
        const signature = await walletState.signer.signMessage(SIGNATURE_MESSAGE);
        keys = await walletState.railgunWallet.generateKeys(walletState.account, signature);
        
        // Update walletState with new keys
        walletState.derivedKeys.spendingKey = ethersLib.utils.arrayify('0x' + keys.spendingKey);
        walletState.derivedKeys.viewingKey = ethersLib.utils.arrayify('0x' + keys.viewingKey);
        walletState.derivedKeys.viewingPublicKey = await walletState.railgunWallet.getViewingPublicKey(keys.viewingKey);
        const mpkBytes = await walletState.railgunWallet.getMPK(keys.spendingKey, keys.viewingKey);
        walletState.mpk = ethersLib.utils.hexlify(mpkBytes);
      }
    }
  } else {
    // No cached keys, need to request signature
    console.log('🔐 No cached keys found, requesting signature...');
    const signature = await walletState.signer.signMessage(SIGNATURE_MESSAGE);
    keys = await walletState.railgunWallet.generateKeys(walletState.account, signature);
    
    // Update walletState with new keys
    walletState.derivedKeys.spendingKey = ethersLib.utils.arrayify('0x' + keys.spendingKey);
    walletState.derivedKeys.viewingKey = ethersLib.utils.arrayify('0x' + keys.viewingKey);
    walletState.derivedKeys.viewingPublicKey = await walletState.railgunWallet.getViewingPublicKey(keys.viewingKey);
    const mpkBytes = await walletState.railgunWallet.getMPK(keys.spendingKey, keys.viewingKey);
    walletState.mpk = ethersLib.utils.hexlify(mpkBytes);
  }
  
  // Final verification (only if walletState.derivedKeys are available)
  if (walletState.derivedKeys.spendingKey) {
    const derivedSpendingKey = '0x' + keys.spendingKey;
    const storedSpendingKey = ethersLib.utils.hexlify(walletState.derivedKeys.spendingKey);
    
    if (derivedSpendingKey.toLowerCase() !== storedSpendingKey.toLowerCase()) {
      throw new Error('密钥不匹配！钱包可能已更换。请重新连接。');
    }
  }
  
  return keys;
}

// Broadcast transaction
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

// Request Merkle root update
function requestUpdateRoot() {
  fetch('/api/update-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(response => response.json())
    .then(result => {
      if (result.success) {
        console.log('✅ Merkle root update requested');
      }
    })
    .catch(() => {});
}

// Wait for Merkle root to be updated
async function waitForMerkleRootUpdate(expectedRoot, maxWaitTime = 30000) {
  const ethersLib = ensureEthers();
  const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.provider);
  
  const startTime = Date.now();
  const checkInterval = 1000; // Check every 1 second
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      // Get current Merkle root from contract
      // Note: We need to call getRoot() from Commitments contract
      // For now, we'll use a simpler approach: wait for update root transaction
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
      // Request update root again if needed
      requestUpdateRoot();
      
      // Wait a bit more for the update to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Try to get the root from the contract
      // Since we don't have direct access to getRoot(), we'll use a timeout approach
      // The server should have updated the root by now
      break;
    } catch (error) {
      console.warn('Error checking Merkle root:', error);
    }
  }
  
  // Additional wait to ensure root is updated
  await new Promise(resolve => setTimeout(resolve, 3000));
}

// Format transaction data for contract
function formatTransactionForContract(transaction) {
  const ethersLib = ensureEthers();
  
  // Validate transaction structure
  if (!transaction || !transaction.proof || !transaction.boundParams) {
    throw new Error('Invalid transaction structure');
  }
  
  const proof = {
    a: {
      x: transaction.proof.a?.x?.toString() || '0',
      y: transaction.proof.a?.y?.toString() || '0',
    },
    b: {
      x: transaction.proof.b?.x?.map(v => v?.toString() || '0') || ['0', '0'],
      y: transaction.proof.b?.y?.map(v => v?.toString() || '0') || ['0', '0'],
    },
    c: {
      x: transaction.proof.c?.x?.toString() || '0',
      y: transaction.proof.c?.y?.toString() || '0',
    },
  };

  const boundParams = {
    treeNumber: transaction.boundParams.treeNumber || 0,
    minGasPrice: transaction.boundParams.minGasPrice?.toString() || '0',
    unshield: transaction.boundParams.unshield || 0,
    chainID: transaction.boundParams.chainID?.toString() || '0',
    adaptContract: transaction.boundParams.adaptContract || '0x0000000000000000000000000000000000000000',
    adaptParams: transaction.boundParams.adaptParams 
      ? ethersLib.utils.hexlify(transaction.boundParams.adaptParams)
      : '0x0000000000000000000000000000000000000000000000000000000000000000',
    commitmentCiphertext: (transaction.boundParams.commitmentCiphertext || []).map(ct => ({
      ciphertext: (ct.ciphertext || []).map(c => c ? ethersLib.utils.hexlify(c) : '0x00'),
      blindedSenderViewingKey: ct.blindedSenderViewingKey ? ethersLib.utils.hexlify(ct.blindedSenderViewingKey) : '0x00',
      blindedReceiverViewingKey: ct.blindedReceiverViewingKey ? ethersLib.utils.hexlify(ct.blindedReceiverViewingKey) : '0x00',
      annotationData: ct.annotationData ? ethersLib.utils.hexlify(ct.annotationData) : '0x00',
      memo: ct.memo ? ethersLib.utils.hexlify(ct.memo) : '0x00',
    })),
  };

  // Helper function to safely hexlify Uint8Array or other types
  const safeHexlify = (value, name = 'value') => {
    if (!value) {
      console.warn(`⚠️ ${name} is null or undefined`);
      return '0x00';
    }
    if (value instanceof Uint8Array) {
      try {
        return ethersLib.utils.hexlify(value);
      } catch (e) {
        console.error(`hexlify error for ${name}:`, e, 'value type:', typeof value, 'value:', value);
        throw e;
      }
    }
    if (typeof value === 'string' && value.startsWith('0x')) {
      return value;
    }
    try {
      return ethersLib.utils.hexlify(value);
    } catch (e) {
      console.error(`hexlify error for ${name}:`, e, 'value type:', typeof value, 'value:', value);
      throw e;
    }
  };

  // Handle unshieldPreimage (required for unshield transactions)
  if (!transaction.unshieldPreimage) {
    throw new Error('unshieldPreimage is required for unshield transaction');
  }
  
  if (!transaction.unshieldPreimage.npk) {
    console.error('❌ unshieldPreimage.npk is null:', transaction.unshieldPreimage);
    throw new Error('unshieldPreimage.npk is null');
  }
  
  const unshieldPreimage = {
    npk: safeHexlify(transaction.unshieldPreimage.npk, 'unshieldPreimage.npk'),
    token: {
      tokenType: transaction.unshieldPreimage.token?.tokenType || 0,
      tokenAddress: transaction.unshieldPreimage.token?.tokenAddress || '0x0000000000000000000000000000000000000000',
      tokenSubID: transaction.unshieldPreimage.token?.tokenSubID?.toString() || '0',
    },
    value: transaction.unshieldPreimage.value?.toString() || '0',
  };

  return {
    proof,
    merkleRoot: safeHexlify(transaction.merkleRoot, 'merkleRoot'),
    nullifiers: (transaction.nullifiers || []).map((n, i) => safeHexlify(n, `nullifiers[${i}]`)),
    commitments: (transaction.commitments || []).map((c, i) => safeHexlify(c, `commitments[${i}]`)),
    boundParams,
    unshieldPreimage,
  };
}

// Deposit to Private Balance (Shield)
export async function handleDeposit(amountValue) {
  console.log('Deposit to private balance, amount:', amountValue);
  
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
  const amountWei = ethersLib.utils.parseEther(amountValue);
  
  // Check balance
  const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
  const balance = await testERC20.balanceOf(walletState.account);

  if (balance.lt(amountWei)) {
    showToast('error', '余额不足', `公开余额不足，当前: ${ethersLib.utils.formatEther(balance)}`);
    return;
  }

  // Check token allowance
  const allowanceInfo = await checkTokenAllowance(amountValue);
  if (!allowanceInfo.hasAllowance) {
    // Show approve button instead of deposit button
    await updateDepositButtonForApproval(amountValue);
    showToast('warning', '需要授权', '请先授权代币才能存入隐私');
    return;
  }

  UI.setButtonLoading('#convert-action-btn', true, '存入中...');
  let depositTx = null;

  try {

    // Create Shield request
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
    
    // Auto close modal after success
    const convertModal = document.getElementById('convert-modal');
    if (convertModal) convertModal.style.display = 'none';
    
    // Background scan to update balance
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

// Private to Public Transfer (Unshield to recipient EOA)
export async function handlePrivateToPublicTransfer(recipientAddress, amountValue) {
  console.log('Private to public transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
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
    
    // Unshield to recipient address
    const unshieldData = await walletState.railgunWallet.prepareUnshieldTransaction(
      walletState.account,
      amountWei.toString(),
      recipientAddress, // Unshield to recipient's EOA
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

    UI.setButtonLoading('#transfer-btn', true, '广播中...');
    showToast('info', '交易已提交', '等待确认...');
    
    const result = await broadcast('unshield', formattedTransaction);
    
    addTransaction('transfer-private-to-public', '隐私到公开转账', `转给 ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');
    showToast('success', '转账成功', `${amountValue} ${erc20TokenInfo.symbol} 已从隐私账户转给 ${formatAddress(recipientAddress)}`);

    // Clear input after successful transfer
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));

    // Background scan to update balance
    (async () => {
      try {
        await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
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
    console.error('Private to public transfer failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}

// Withdraw to Public Balance (Unshield)
export async function handleWithdraw(amountValue) {
  console.log('Withdraw to public balance, amount:', amountValue);
  
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
  
  // Check private balance
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

    // Auto close modal after success
    const convertModal = document.getElementById('convert-modal');
    if (convertModal) convertModal.style.display = 'none';

    // Background scan to update balance
    (async () => {
      try {
        await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
        await refreshBalances();
      } catch (scanError) {
        console.warn('Background scan failed:', scanError.message);
      }
    })();

  } catch (error) {
    console.error('Withdraw failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了签名');
    } else {
      showToast('error', '提取失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#convert-action-btn', false);
  }
}

// Public to Public Transfer (EOA to EOA)
export async function handlePublicToPublicTransfer(recipientAddress, amountValue) {
  return handlePublicTransfer(recipientAddress, amountValue);
}

// Public Transfer (legacy, kept for backward compatibility)
export async function handlePublicTransfer(recipientAddress, amountValue) {
  console.log('Public transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
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
  
  // Check balance
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
    
    // Clear input after successful transfer
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
    
    await refreshBalances();

  } catch (error) {
    console.error('Public transfer failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}

// Public to Private Transfer (Shield to recipient's privacy account)
export async function handlePublicToPrivateTransfer(recipientAddress, amountValue) {
  console.log('Public to private transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    showToast('error', '钱包未连接', '请先连接钱包');
    return;
  }

  if (!walletState.isPrivacyEnabled) {
    showToast('error', '隐私未启用', '请先启用隐私交易才能发送到隐私账户');
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

  // Lookup recipient MPK
  const userInfo = await lookupMPK(recipientAddress);
  
  if (!userInfo) {
    showToast('error', '收款方未注册', '收款方尚未启用隐私交易，无法发送到隐私账户');
    return;
  }

  const amountWei = ethersLib.utils.parseEther(amountValue);
  
  // Check public balance
  const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
  const balance = await testERC20.balanceOf(walletState.account);

  if (balance.lt(amountWei)) {
    showToast('error', '余额不足', `公开余额不足，当前: ${ethersLib.utils.formatEther(balance)}`);
    return;
  }

  // Check token allowance
  const allowanceInfo = await checkTokenAllowance(amountValue);
  if (!allowanceInfo.hasAllowance) {
    showToast('warning', '需要授权', '请先授权代币才能发送到隐私账户');
    // Trigger approval flow
    try {
      await approveToken(amountValue);
      // Retry after approval
      setTimeout(() => handlePublicToPrivateTransfer(recipientAddress, amountValue), 1000);
    } catch (err) {
      console.error('Approval failed:', err);
    }
    return;
  }

  UI.setButtonLoading('#transfer-btn', true, '准备交易...');

  try {
    // Step 1: Shield to our own privacy account first
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

    UI.setButtonLoading('#transfer-btn', true, '存入隐私中...');
    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    const shieldTx = await railgun.shield([shieldRequest], { gasLimit: 500000 });
    
    showToast('info', '第一步完成', '等待 Merkle Root 更新...');
    await shieldTx.wait();

    // Step 2: Request Merkle root update and wait for it
    requestUpdateRoot();
    UI.setButtonLoading('#transfer-btn', true, '等待 Merkle Root 更新...');
    
    // Wait for Merkle root to be updated (important for next transaction)
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for root update
    
    // Step 3: Scan the shield transaction to update our UTXOs
    await walletState.railgunWallet.scanTransaction(shieldTx.hash, walletState.account);
    
    // Additional wait to ensure Merkle tree is fully updated
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 4: Transfer from our privacy account to recipient's privacy account
    UI.setButtonLoading('#transfer-btn', true, '请签名确认...');
    await requestSignatureConfirmation();
    
    UI.setButtonLoading('#transfer-btn', true, '转账到对方隐私账户...');

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
    
    addTransaction('transfer-public-to-private', '公开到隐私转账', `转给 ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');
    showToast('success', '转账成功', `${amountValue} ${erc20TokenInfo.symbol} 已发送到 ${formatAddress(recipientAddress)} 的隐私账户。接收方需要刷新页面或重新连接钱包才能看到资产。`);

    // Clear input after successful transfer
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));

    // Background scan to update balance (sender only - recipient needs to scan with their own keys)
    (async () => {
      try {
        // Scan for sender (to update change note)
        await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
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
    console.error('Public to private transfer failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了交易');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}

// Private Transfer (Private to Private)
export async function handlePrivateTransfer(recipientAddress, amountValue) {
  console.log('Private transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
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

  // Lookup recipient MPK
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

    // Clear input after successful transfer
    const transferAmountInput = document.getElementById('transfer-amount');
    if (transferAmountInput) transferAmountInput.value = '';
    document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));

    // Background scan to update balance
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
        console.warn('Background scan failed:', scanError.message);
      }
    })();

  } catch (error) {
    console.error('Private transfer failed:', error);
    
    if (error.code === 4001) {
      showToast('warning', '交易已取消', '用户取消了签名');
    } else {
      showToast('error', '转账失败', error.message);
    }
  } finally {
    UI.setButtonLoading('#transfer-btn', false);
  }
}
