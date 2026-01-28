// Transaction Functions

import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, waitForTransactionFast } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances } from './wallet.js';
import { TX_TYPES, TX_LABELS, BUTTON_STATES } from './constants.js';
import * as UI from './ui.js';

// ==================== Helper Functions ====================

/**
 * Set button loading state
 */
function setButtonLoading(selectors, isLoading, state = null) {
  selectors.forEach(selector => {
    UI.setButtonLoading(selector, isLoading, state);
  });
}

/**
 * Request user signature
 */
async function requestSignature() {
  await walletState.signer.signMessage('Railgun Spendingkey');
}

/**
 * Broadcast transaction via server
 */
async function broadcastTransaction(type, transaction) {
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

/**
 * Format transaction for contract
 */
function formatTransactionForContract(transaction) {
  const ethersLib = ensureEthers();
  
  return {
    proof: {
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
    },
    merkleRoot: ethersLib.utils.hexlify(transaction.merkleRoot),
    nullifiers: transaction.nullifiers.map(n => ethersLib.utils.hexlify(n)),
    commitments: transaction.commitments.map(c => ethersLib.utils.hexlify(c)),
    boundParams: {
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
    },
    unshieldPreimage: {
      npk: ethersLib.utils.hexlify(transaction.unshieldPreimage.npk),
      token: {
        tokenType: transaction.unshieldPreimage.token.tokenType,
        tokenAddress: transaction.unshieldPreimage.token.tokenAddress,
        tokenSubID: transaction.unshieldPreimage.token.tokenSubID.toString(),
      },
      value: transaction.unshieldPreimage.value.toString(),
    },
  };
}

/**
 * Create shield request
 */
async function createShieldRequest(amountValue) {
  const ethersLib = ensureEthers();
  const amountWei = ethersLib.utils.parseEther(amountValue);
  
  const shieldRequestRaw = await walletState.railgunWallet.createShieldRequest(
    walletState.account,
    amountWei.toString(),
    contracts.testERC20,
    0,
    0n
  );
  
  const formatBytes32 = (value) => {
    return value instanceof Uint8Array
      ? ethersLib.utils.hexZeroPad(ethersLib.utils.hexlify(value), 32)
      : ethersLib.utils.hexZeroPad(value, 32);
  };
  
  return {
    preimage: {
      npk: formatBytes32(shieldRequestRaw.preimage.npk),
      token: {
        tokenType: shieldRequestRaw.preimage.token.tokenType,
        tokenAddress: shieldRequestRaw.preimage.token.tokenAddress,
        tokenSubID: ethersLib.BigNumber.from(shieldRequestRaw.preimage.token.tokenSubID.toString())
      },
      value: ethersLib.BigNumber.from(shieldRequestRaw.preimage.value.toString())
    },
    ciphertext: {
      encryptedBundle: shieldRequestRaw.ciphertext.encryptedBundle.map(bundle => formatBytes32(bundle)),
      shieldKey: formatBytes32(shieldRequestRaw.ciphertext.shieldKey)
    }
  };
}

// ==================== Transaction Functions ====================

/**
 * Public to Private (Shield)
 */
export async function handleShield(amountValue) {
  console.log('Public to Private, amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) return;
  if (!walletState.isRegistered) return;
  
  const amount = parseFloat(amountValue);
  if (!amount || amount <= 0) return;
  
  const buttons = ['#shield-btn', '#convert-action-btn'];
  let shieldTx = null;

  try {
    setButtonLoading(buttons, true, BUTTON_STATES.PREPARING);
    
    const ethersLib = ensureEthers();
    const shieldRequest = await createShieldRequest(amountValue);
    
    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    
    let gasLimit;
    try {
      const estimatedGas = await railgun.estimateGas.shield([shieldRequest]);
      gasLimit = estimatedGas.mul(120).div(100);
    } catch (error) {
      gasLimit = ethersLib.BigNumber.from(2000000);
    }
    
    shieldTx = await railgun.shield([shieldRequest], { gasLimit });
    addTransaction(
      TX_TYPES.SHIELD,
      TX_LABELS.PUBLIC_TO_PRIVATE,
      `Moving ${amountValue} ${erc20TokenInfo.symbol} to private`,
      `+${amountValue} ${erc20TokenInfo.symbol}`,
      shieldTx.hash,
      'pending'
    );
    
    await shieldTx.wait();
    
    updateTransactionStatus(
      shieldTx.hash,
      'success',
      TX_LABELS.PUBLIC_TO_PRIVATE,
      `Moved ${amountValue} ${erc20TokenInfo.symbol} to private`
    );
    
    // Scan and update in background
    (async () => {
      try {
        await walletState.railgunWallet.registerAccount(walletState.account);
        await walletState.railgunWallet.scanTransaction(shieldTx.hash, walletState.account);
        
        const privateBalance = await walletState.railgunWallet.getBalance(
          walletState.account,
          contracts.testERC20,
          0
        );
        walletState.privateBalance = parseFloat(ethersLib.utils.formatEther(privateBalance)).toFixed(2);
        await refreshBalances();
      } catch (error) {
        console.warn('Background scan failed:', error.message);
      }
    })();
    
  } catch (error) {
    console.error('Shield failed:', error);
    
    if (error.code === 4001) {
      console.warn('User cancelled');
      return;
    }
    
    const txHash = shieldTx?.hash || error.transaction?.hash;
    if (txHash) {
      updateTransactionStatus(txHash, 'failed', TX_LABELS.PUBLIC_TO_PRIVATE, `Failed`);
    }
  } finally {
    setButtonLoading(buttons, false);
  }
}

/**
 * Private to Public (Unshield)
 */
export async function handleUnshield(amountValue, recipientAddress = null) {
  const recipient = recipientAddress || walletState.account;
  console.log('Private to Public, amount:', amountValue, 'recipient:', recipient);
  
  if (!walletState.signer || !walletState.account) return;
  
  const amount = parseFloat(amountValue);
  if (!amount || amount <= 0) return;
  
  const buttons = ['#unshield-btn', '#convert-action-btn'];

  try {
    setButtonLoading(buttons, true, BUTTON_STATES.SIGNING);
    await requestSignature();
    
    setButtonLoading(buttons, true, BUTTON_STATES.PREPARING);
    
    const ethersLib = ensureEthers();
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
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

    setButtonLoading(buttons, true, BUTTON_STATES.BROADCASTING);
    const result = await broadcastTransaction('unshield', formattedTransaction);
    
    const isSelf = recipient.toLowerCase() === walletState.account.toLowerCase();
    const { formatAddress } = await import('./utils.js');
    
    if (isSelf) {
      addTransaction(TX_TYPES.UNSHIELD, TX_LABELS.PRIVATE_TO_PUBLIC, `Moving to public balance`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'pending');
    } else {
      addTransaction(TX_TYPES.TRANSFER_OUT, TX_LABELS.TRANSFER_OUT, `To ${formatAddress(recipient)} (public)`, `-${amountValue} ${erc20TokenInfo.symbol}`, result.txHash, 'pending');
    }

    setButtonLoading(buttons, true, BUTTON_STATES.CONFIRMING);
    const receipt = await waitForTransactionFast(walletState.provider, result.txHash);
    
    if (receipt.status === 0) {
      throw new Error('Transaction reverted');
    }
    
    if (isSelf) {
      updateTransactionStatus(result.txHash, 'success', TX_LABELS.PRIVATE_TO_PUBLIC, `Moved to public balance`);
    } else {
      updateTransactionStatus(result.txHash, 'success', TX_LABELS.TRANSFER_OUT, `To ${formatAddress(recipient)} (public)`);
    }

    setButtonLoading(buttons, true, BUTTON_STATES.UPDATING);
    await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
    await refreshBalances();

  } catch (error) {
    console.error('Unshield failed:', error);
    if (error.code === 4001) {
      console.warn('User cancelled');
    }
  } finally {
    setButtonLoading(buttons, false);
  }
}

/**
 * ERC20 Transfer (Public)
 */
export async function handleERC20Transfer(recipientAddress, amountValue) {
  console.log('ERC20 Transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) return;
  
  const amount = parseFloat(amountValue);
  if (!amount || amount <= 0) return;
  
  const ethersLib = ensureEthers();
  if (!ethersLib.utils.isAddress(recipientAddress)) return;
  
  const buttons = ['#erc20-transfer-btn'];
  let erc20Tx = null;

  try {
    setButtonLoading(buttons, true, BUTTON_STATES.PREPARING);
    
    const amountWei = ethersLib.utils.parseEther(amountValue);
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    
    erc20Tx = await testERC20.transfer(recipientAddress, amountWei);
    const { formatAddress } = await import('./utils.js');
    addTransaction(
      TX_TYPES.ERC20,
      TX_LABELS.PUBLIC_TRANSFER,
      `To ${formatAddress(recipientAddress)}`,
      `-${amountValue} ${erc20TokenInfo.symbol}`,
      erc20Tx.hash,
      'pending'
    );
    
    const receipt = await erc20Tx.wait();
    
    if (receipt.status === 0) {
      throw new Error('Transaction reverted');
    }

    updateTransactionStatus(erc20Tx.hash, 'success', TX_LABELS.PUBLIC_TRANSFER, `To ${formatAddress(recipientAddress)}`);
    await refreshBalances();

  } catch (error) {
    console.error('ERC20 Transfer failed:', error);
    
    if (error.code === 4001) {
      console.warn('User cancelled');
      return;
    }
    
    const txHash = erc20Tx?.hash || error.transaction?.hash;
    if (txHash) {
      updateTransactionStatus(txHash, 'failed', TX_LABELS.PUBLIC_TRANSFER, `Failed`);
    }
  } finally {
    setButtonLoading(buttons, false);
  }
}

/**
 * Private Transfer (to registered recipient)
 */
async function doPrivateTransfer(recipientAddress, amountValue, userInfo) {
  console.log('Private Transfer, recipient:', recipientAddress, 'amount:', amountValue);
  
  if (!walletState.signer || !walletState.account) return;
  
  const amount = parseFloat(amountValue);
  if (!amount || amount <= 0) return;
  
  const buttons = ['#private-transfer-btn'];

  try {
    setButtonLoading(buttons, true, BUTTON_STATES.SIGNING);
    await requestSignature();
    
    setButtonLoading(buttons, true, BUTTON_STATES.PREPARING);
    
    const ethersLib = ensureEthers();
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
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

    setButtonLoading(buttons, true, BUTTON_STATES.BROADCASTING);
    const result = await broadcastTransaction('transfer', formattedTransaction);
    
    const { formatAddress } = await import('./utils.js');
    addTransaction(
      TX_TYPES.TRANSFER,
      TX_LABELS.PRIVATE_TRANSFER,
      `To ${formatAddress(recipientAddress)}`,
      `-${amountValue} ${erc20TokenInfo.symbol}`,
      result.txHash,
      'pending'
    );

    setButtonLoading(buttons, true, BUTTON_STATES.CONFIRMING);
    const receipt = await waitForTransactionFast(walletState.provider, result.txHash);
    
    if (receipt.status === 0) {
      throw new Error('Transaction reverted');
    }
    
    updateTransactionStatus(result.txHash, 'success', TX_LABELS.PRIVATE_TRANSFER, `To ${formatAddress(recipientAddress)}`);

    setButtonLoading(buttons, true, BUTTON_STATES.UPDATING);
    await walletState.railgunWallet.scanTransaction(result.txHash, walletState.account);
    await walletState.railgunWallet.scanTransaction(result.txHash, recipientAddress, [{
      tokenType: 0,
      tokenAddress: contracts.testERC20,
      tokenSubID: 0n,
    }]);
    await refreshBalances();

  } catch (error) {
    console.error('Private Transfer failed:', error);
    if (error.code === 4001) {
      console.warn('User cancelled');
    }
  } finally {
    setButtonLoading(buttons, false);
  }
}

/**
 * Unified Transfer (handles both public and private)
 */
export async function handleUnifiedTransfer(recipientAddress, amountValue, usePrivacy) {
  console.log('Unified Transfer:', { recipientAddress, amountValue, usePrivacy });
  
  if (!walletState.signer || !walletState.account) return;
  
  const ethersLib = ensureEthers();
  if (!ethersLib.utils.isAddress(recipientAddress)) return;

  if (usePrivacy) {
    const { lookupMPK } = await import('./wallet.js');
    const userInfo = await lookupMPK(recipientAddress);
    const isRecipientRegistered = userInfo && userInfo.mpk !== '0x0000000000000000000000000000000000000000000000000000000000000000';
    
    if (isRecipientRegistered) {
      console.log('→ Private Transfer');
      await doPrivateTransfer(recipientAddress, amountValue, userInfo);
    } else {
      console.log('→ Private to Public (recipient not registered)');
      await handleUnshield(amountValue, recipientAddress);
    }
  } else {
    console.log('→ ERC20 Transfer');
    await handleERC20Transfer(recipientAddress, amountValue);
  }
}
