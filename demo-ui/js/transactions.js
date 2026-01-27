// Transaction Functions (Shield, Unshield, Transfer)
import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, validateAmount } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances } from './wallet.js';
import * as UI from './ui.js';

// Signature message for key derivation
const SIGNATURE_MESSAGE = 'Railgun Spendingkey';

// Request user signature confirmation
async function requestSignatureConfirmation() {
  const ethersLib = ensureEthers();
  
  // Request signature from MetaMask
  const signature = await walletState.signer.signMessage(SIGNATURE_MESSAGE);
  
  // Derive keys from signature
  const keys = await walletState.railgunWallet.generateKeys(walletState.account, signature);
  
  // Verify keys match stored keys
  const derivedSpendingKey = '0x' + keys.spendingKey;
  const storedSpendingKey = ethersLib.utils.hexlify(walletState.derivedKeys.spendingKey);
  
  if (derivedSpendingKey.toLowerCase() !== storedSpendingKey.toLowerCase()) {
    throw new Error('Key mismatch! Wallet may have changed. Please reconnect.');
  }
  
  return keys;
}

// Broadcast transaction via server API
async function broadcast(type, transaction) {
  const response = await fetch('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, transaction })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Broadcast failed');
  }
  return result;
}

// Request broadcaster to update Merkle root
async function requestUpdateRoot() {
  try {
    const response = await fetch('/api/update-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!result.success) {
      console.warn('Update root failed:', result.error);
    } else {
      console.log('✅ Update root confirmed in block:', result.blockNumber);
    }
  } catch (error) {
    console.warn('Update root request failed:', error.message);
  }
}

// Helper: Format transaction for contract
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

// Shield function
export async function handleShield(amountValue) {
  console.log('Shield button clicked, amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    console.error('Shield failed: Wallet not connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    console.error('Shield failed: Keys not derived');
    return;
  }

  // Check if user has registered MPK
  if (!walletState.isRegistered) {
    console.error('Shield failed: MPK not registered');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    console.error('Shield failed: Invalid amount -', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#shield-panel .submit-btn', true, 'Shielding...');
  let shieldTx = null;

  try {
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
    // Check contract configuration
    if (contracts.railgun === '0x0000000000000000000000000000000000000000') {
      console.error('Shield failed: Railgun contract not configured');
      return;
    }

    if (contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
      console.error('Shield failed: TestERC20 contract not configured');
      return;
    }

    // Check balance
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    const balance = await testERC20.balanceOf(walletState.account);

    if (balance.lt(amountWei)) {
      console.error('Shield failed: Insufficient balance. Have:', ethersLib.utils.formatEther(balance), 'Need:', amountValue);
      return;
    }

    // Create shield request
    const shieldRequestRaw = await walletState.railgunWallet.createShieldRequest(
      walletState.account,
      amountWei.toString(),
      contracts.testERC20,
      0, // TokenType.ERC20
      0n // tokenSubID
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

    // Call shield function
    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    
    // Estimate gas (let ethers.js handle gas price automatically)
    let gasLimit;
    try {
      const estimatedGas = await railgun.estimateGas.shield([shieldRequest]);
      gasLimit = estimatedGas.mul(120).div(100);
    } catch (error) {
      console.warn('Gas estimation failed, using default:', error.message);
      gasLimit = ethersLib.BigNumber.from(2000000);
    }

    // 1. Send shield transaction and wait for confirmation
    shieldTx = await railgun.shield([shieldRequest], { gasLimit });
    addTransaction('shield', 'Shield', `Shielding ${amountValue} ${erc20TokenInfo.symbol}`, `+${amountValue} ${erc20TokenInfo.symbol}`, shieldTx.hash, 'pending');
    
    const receipt = await shieldTx.wait();
    
    // 2. After shield confirmed, send updateRoot and wait for confirmation
    await requestUpdateRoot();

    // Update UI immediately
    updateTransactionStatus(shieldTx.hash, 'success', 'Shield', `Shielded ${amountValue} ${erc20TokenInfo.symbol}`);
    
    // Scan transaction and update balances in background
    (async () => {
      try {
        await walletState.railgunWallet.registerAccount(walletState.account);
        await walletState.railgunWallet.scanTransaction(shieldTx.hash, walletState.account);
        
        // Update balances
        const privateBalance = await walletState.railgunWallet.getBalance(
          walletState.account,
          contracts.testERC20,
          0
        );
        walletState.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);
        
        await refreshBalances();
        console.log('✅ Shield scanned and balances updated');
      } catch (scanError) {
        console.warn('Background scan failed:', scanError.message);
      }
    })();
    

  } catch (error) {
    console.error('Shield failed:', error);
    
    // Extract tx hash if available
    let txHash = shieldTx?.hash || error.transaction?.hash || error.receipt?.transactionHash;
    
    if (txHash) {
      // Update existing transaction status instead of adding a new one
      updateTransactionStatus(txHash, 'failed', 'Shield', `Failed to shield ${amountValue} ${erc20TokenInfo.symbol}`);
    }
    
  } finally {
    UI.setButtonLoading('#shield-panel .submit-btn', false);
  }
}

// Unshield function
export async function handleUnshield(amountValue) {
  console.log('Unshield button clicked, amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) {
    console.error('Unshield failed: Wallet not connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    console.error('Unshield failed: Keys not derived');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    console.error('Unshield failed: Invalid amount -', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  
  // Pre-check balance before showing loading state
  const amountWei = ethersLib.utils.parseEther(amountValue);
  const privateBalance = await walletState.railgunWallet.getBalance(
    walletState.account,
    contracts.testERC20,
    0
  );
  
  if (privateBalance < amountWei.toBigInt()) {
    return;
  }

  UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Sign to confirm...');

  try {
    await requestSignatureConfirmation();
    
    UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Preparing...');
    const recipient = walletState.account;

    // Prepare unshield transaction
    const unshieldData = await walletState.railgunWallet.prepareUnshieldTransaction(
      walletState.account,
      amountWei.toString(),
      recipient,
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

    // Broadcast via server
    UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Broadcasting...');
    const result = await broadcast('unshield', formattedTransaction);
    
    // Broadcast returns only when confirmed, so add as success directly
    addTransaction('unshield', 'Unshield', `Unshield ${amountValue} ${erc20TokenInfo.symbol}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');

    // Scan transaction and refresh balances (must complete before unlocking button)
    UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Updating balances...');
    await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
    await refreshBalances();
    console.log('✅ Unshield scanned and balances updated');

  } catch (error) {
    console.error('Unshield failed:', error);
  } finally {
    UI.setButtonLoading('#unshield-panel .submit-btn', false);
  }
}

// Transfer function
export async function handleTransfer(recipientAddress, amountValue) {
  console.log('Transfer button clicked, recipient:', recipientAddress, 'amount:', amountValue);
  
  if (!walletState.signer) {
    console.error('Transfer failed: Wallet not connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    console.error('Transfer failed: Keys not derived');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    console.error('Transfer failed: Invalid amount -', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  
  if (!ethersLib.utils.isAddress(recipientAddress)) {
    console.error('Transfer failed: Invalid recipient address -', recipientAddress);
    return;
  }

  // Pre-check recipient and balance before showing loading state
  const { lookupMPK } = await import('./wallet.js');
  const userInfo = await lookupMPK(recipientAddress);
  
  if (!userInfo) {
    console.error('Recipient MPK not found');
    alert('Recipient has not registered their MPK. They need to connect and register first.');
    return;
  }

  const amountWei = ethersLib.utils.parseEther(amountValue);
  const privateBalance = await walletState.railgunWallet.getBalance(
    walletState.account,
    contracts.testERC20,
    0
  );
  
  if (privateBalance < amountWei.toBigInt()) {
    console.error('Unshield failed: Insufficient private balance. Have:', ethersLib.utils.formatEther(privateBalance), 'Need:', amountValue);
    return;
  }

  UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Sign to confirm...');

  try {
    await requestSignatureConfirmation();
    
    UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Preparing...');

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

    // Broadcast via server
    UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Broadcasting...');
    const result = await broadcast('transfer', formattedTransaction);
    
    const { formatAddress } = await import('./utils.js');
    // Broadcast returns only when confirmed, so add as success directly
    addTransaction('transfer', 'Private Transfer', `To ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'success');

    // Scan transaction and refresh balances (must complete before unlocking button)
    UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Updating balances...');
    await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
    await walletState.railgunWallet.scanTransaction(result.txHash, recipientAddress, [{
      tokenType: 0,
      tokenAddress: contracts.testERC20,
      tokenSubID: 0n,
    }]);
    await refreshBalances();
    console.log('✅ Transfer scanned and balances updated');

  } catch (error) {
    console.error('Transfer failed:', error);
  } finally {
    UI.setButtonLoading('#transfer-panel .submit-btn', false);
  }
}
