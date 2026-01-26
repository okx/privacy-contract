// Transaction Functions (Shield, Unshield, Transfer)
import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, validateAmount } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances } from './wallet.js';
import { toast } from '../components/toast.js';
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
async function broadcast(type, transaction, railgunAddress) {
  const response = await fetch('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, transaction, railgunAddress })
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Broadcast failed');
  }
  return result;
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
  if (!walletState.signer || !walletState.account) {
    toast.warning('Please connect your wallet first', 'Not Connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    toast.warning('Please generate MPK first', 'MPK Required');
    return;
  }

  // Check if user has registered MPK
  if (!walletState.isRegistered) {
    toast.warning('Please register your MPK before shielding. Click the "Register MPK" button.', 'Registration Required');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    toast.error(error.message, 'Invalid Amount');
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#shield-panel .submit-btn', true, 'Shielding...');
  let shieldTx = null;

  try {
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
    // Check contract configuration
    if (contracts.railgun === '0x0000000000000000000000000000000000000000') {
      toast.error('Railgun contract not configured', 'Configuration Error');
      return;
    }

    if (contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
      toast.error('TestERC20 contract not configured', 'Configuration Error');
      return;
    }

    // Check balance and allowance
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    const balance = await testERC20.balanceOf(walletState.account);
    const allowance = await testERC20.allowance(walletState.account, contracts.railgun);

    if (balance.lt(amountWei)) {
      toast.error(`Insufficient balance: ${ethersLib.utils.formatEther(balance)} / ${amountValue}`, 'Insufficient Balance');
      return;
    }

    // Approve if needed
    if (allowance.lt(amountWei)) {
      UI.setButtonLoading('#shield-panel .submit-btn', true, 'Approving...');
      const approveTx = await testERC20.approve(contracts.railgun, ethersLib.constants.MaxUint256);
      toast.txPending(approveTx.hash, 'Approving token spend...');
      await approveTx.wait();
      toast.success('Approval confirmed!', 'Approved');
      
      // Brief delay before next transaction
      UI.setButtonLoading('#shield-panel .submit-btn', true, 'Preparing Shield...');
      await new Promise(resolve => setTimeout(resolve, 1500));
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
    
    // Estimate gas
    let gasLimit;
    try {
      const estimatedGas = await railgun.estimateGas.shield([shieldRequest]);
      gasLimit = estimatedGas.mul(120).div(100);
    } catch (error) {
      console.warn('Gas estimation failed, using default:', error.message);
      gasLimit = ethersLib.BigNumber.from(10000000);
    }

    shieldTx = await railgun.shield([shieldRequest], { gasLimit });
    
    addTransaction('shield', 'Shield', `Shielding ${amountValue} ${erc20TokenInfo.symbol}`, `+${amountValue} ${erc20TokenInfo.symbol}`, shieldTx.hash, 'pending');
    toast.txPending(shieldTx.hash, `Shielding ${amountValue} ${erc20TokenInfo.symbol}...`);
    
    const receipt = await shieldTx.wait();

    // Scan transaction
    await walletState.railgunWallet.registerAccount(walletState.account);
    await walletState.railgunWallet.scanTransaction(shieldTx.hash, walletState.account);
    
    // Update balances
    const privateBalance = await walletState.railgunWallet.getBalance(
      walletState.account,
      contracts.testERC20,
      0
    );
    walletState.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);

    updateTransactionStatus(shieldTx.hash, 'success', 'Shield', `Shielded ${amountValue} ${erc20TokenInfo.symbol}`);
    await refreshBalances();
    
    toast.txSuccess(`Successfully shielded ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Shield failed:', error);
    
    // Extract tx hash if available
    let txHash = shieldTx?.hash || error.transaction?.hash || error.receipt?.transactionHash;
    
    if (txHash) {
      addTransaction('shield', 'Shield', `Failed to shield ${amountValue} ${erc20TokenInfo.symbol}`, `+${amountValue} ${erc20TokenInfo.symbol}`, txHash, 'failed');
    }
    
    toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#shield-panel .submit-btn', false);
  }
}

// Unshield function
export async function handleUnshield(amountValue) {
  if (!walletState.signer || !walletState.account) {
    toast.warning('Please connect your wallet first', 'Not Connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    toast.warning('Please generate MPK first', 'MPK Required');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    toast.error(error.message, 'Invalid Amount');
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Sign to confirm...');

  try {
    // Request signature confirmation
    await requestSignatureConfirmation();
    toast.info('Signature verified', 'Confirmed');
    
    UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Preparing...');
    const amountWei = ethersLib.utils.parseEther(amountValue);
    const recipient = walletState.account;

    // Check private balance
    const privateBalance = await walletState.railgunWallet.getBalance(
      walletState.account,
      contracts.testERC20,
      0
    );
    
    if (privateBalance < amountWei.toBigInt()) {
      toast.error(`Insufficient private balance: ${ethersLib.utils.formatEther(privateBalance)} / ${amountValue}`, 'Insufficient Balance');
      return;
    }

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
    const result = await broadcast('unshield', formattedTransaction, contracts.railgun);
    
    addTransaction('unshield', 'Unshield', `Unshield ${amountValue} ${erc20TokenInfo.symbol}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'pending');
    toast.txPending(result.txHash, `Unshielding ${amountValue} ${erc20TokenInfo.symbol}...`);

    try {
      await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
    } catch (scanError) {
      console.warn('Scan error (non-critical):', scanError.message);
    }

    updateTransactionStatus(result.txHash, 'success');
    await refreshBalances();
    
    toast.txSuccess(`Successfully unshielded ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Unshield failed:', error);
    toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#unshield-panel .submit-btn', false);
  }
}

// Transfer function
export async function handleTransfer(recipientAddress, amountValue) {
  if (!walletState.signer) {
    toast.warning('Please connect your wallet first', 'Not Connected');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    toast.warning('Please generate MPK first', 'MPK Required');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    toast.error(error.message, 'Invalid Amount');
    return;
  }

  const ethersLib = ensureEthers();
  
  if (!ethersLib.utils.isAddress(recipientAddress)) {
    toast.error('Invalid recipient address', 'Invalid Address');
    return;
  }

  UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Sign to confirm...');

  try {
    // Request signature confirmation
    await requestSignatureConfirmation();
    toast.info('Signature verified', 'Confirmed');
    
    UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Preparing...');
    
    // Import lookupMPK from wallet.js
    const { lookupMPK } = await import('./wallet.js');
    const userInfo = await lookupMPK(recipientAddress);
    
    if (!userInfo) {
      toast.error(`Recipient ${recipientAddress.slice(0,10)}... is not registered`, 'Recipient Not Registered');
      return;
    }

    const amountWei = ethersLib.utils.parseEther(amountValue);

    const privateBalance = await walletState.railgunWallet.getBalance(
      walletState.account,
      contracts.testERC20,
      0
    );
    
    if (privateBalance < amountWei.toBigInt()) {
      toast.error(`Insufficient private balance: ${ethersLib.utils.formatEther(privateBalance)} / ${amountValue}`, 'Insufficient Balance');
      return;
    }

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
    const result = await broadcast('transfer', formattedTransaction, contracts.railgun);
    
    const { formatAddress } = await import('./utils.js');
    addTransaction('transfer', 'Private Transfer', `To ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'pending');
    toast.txPending(result.txHash, `Transferring ${amountValue} ${erc20TokenInfo.symbol}...`);

    try {
      await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
      await walletState.railgunWallet.scanTransaction(result.txHash, recipientAddress, [{
        tokenType: 0,
        tokenAddress: contracts.testERC20,
        tokenSubID: 0n,
      }]);
    } catch (scanError) {
      console.warn('Scan error:', scanError.message);
    }

    updateTransactionStatus(result.txHash, 'success');
    await refreshBalances();
    
    toast.txSuccess(`Successfully transferred ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Transfer failed:', error);
    toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#transfer-panel .submit-btn', false);
  }
}
