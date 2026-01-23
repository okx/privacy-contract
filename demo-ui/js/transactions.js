// Transaction Functions (Shield, Unshield, Transfer)
import { CONFIG, contracts, erc20TokenInfo } from './config.js';
import { ensureEthers, validateAmount } from './utils.js';
import { walletState, addTransaction, updateTransactionStatus, refreshBalances } from './wallet.js';
import { toast } from '../components/toast.js';
import * as UI from './ui.js';

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
    // toast.warning('Please connect your wallet first', 'Not Connected');
    console.warn('Not Connected: Please connect your wallet first');
    alert('⚠️ Please connect your wallet first');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    // toast.warning('Please generate MPK first!\n\nClick "Generate MPK" button to derive keys from your wallet signature.', 'MPK Required');
    console.warn('MPK Required: Please generate MPK first');
    alert('⚠️ Please generate MPK first');
    return;
  }

  // Check if user has registered MPK
  if (!walletState.isRegistered) {
    console.error('MPK Not Registered: Please register your MPK before shielding');
    alert('⚠️ Please register your MPK before shielding\n\nClick the "Register MPK" button in the sidebar first.');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    // toast.error(error.message, 'Invalid Amount');
    console.error('Invalid Amount:', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#shield-panel .submit-btn', true, 'Shielding...');
  let shieldTx = null;

  try {
    const amountWei = ethersLib.utils.parseEther(amountValue);
    
    // Check contract configuration
    if (contracts.railgun === '0x0000000000000000000000000000000000000000') {
      // toast.error('Railgun contract not configured!\n\nPlease ensure deployments.json exists in project root.', 'Configuration Error');
      console.error('Configuration Error: Railgun contract not configured');
      return;
    }

    if (contracts.testERC20 === '0x0000000000000000000000000000000000000000') {
      // toast.error('TestERC20 contract not configured!', 'Configuration Error');
      console.error('Configuration Error: TestERC20 contract not configured');
      return;
    }

    // Check balance and allowance
    const testERC20 = new ethersLib.Contract(contracts.testERC20, CONFIG.TEST_ERC20_ABI, walletState.signer);
    const balance = await testERC20.balanceOf(walletState.account);
    const allowance = await testERC20.allowance(walletState.account, contracts.railgun);

    if (balance.lt(amountWei)) {
      // toast.error(`Insufficient ERC20 balance!\n\nYour balance: ${ethersLib.utils.formatEther(balance)} tokens\nRequired: ${amountValue} tokens`, 'Insufficient Balance');
      console.error('Insufficient Balance:', `Balance: ${ethersLib.utils.formatEther(balance)}, Required: ${amountValue}`);
      return;
    }

    // Approve if needed
    if (allowance.lt(amountWei)) {
      const approveTx = await testERC20.approve(contracts.railgun, ethersLib.constants.MaxUint256);
      // toast.txPending(approveTx.hash, 'Approving token spend...');
      await approveTx.wait();
      // toast.success('Token approval confirmed');
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
    // toast.txPending(shieldTx.hash, `Shielding ${amountValue} ${erc20TokenInfo.symbol}...`);
    
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
    
    // toast.txSuccess(`Successfully shielded ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Shield failed:', error);
    
    // Extract tx hash if available
    let txHash = shieldTx?.hash || error.transaction?.hash || error.receipt?.transactionHash;
    
    if (txHash) {
      addTransaction('shield', 'Shield', `Failed to shield ${amountValue} ${erc20TokenInfo.symbol}`, `+${amountValue} ${erc20TokenInfo.symbol}`, txHash, 'failed');
    }
    
    // toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#shield-panel .submit-btn', false);
  }
}

// Unshield function
export async function handleUnshield(amountValue) {
  if (!walletState.signer || !walletState.account) {
    // toast.warning('Please connect your wallet first', 'Not Connected');
    console.warn('Not Connected: Please connect your wallet first');
    return;
  }

  if (!walletState.derivedKeys.spendingKey || !walletState.derivedKeys.viewingKey) {
    // toast.warning('Please generate MPK first!', 'MPK Required');
    console.warn('MPK Required: Please generate MPK first');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    // toast.error(error.message, 'Invalid Amount');
    console.error('Invalid Amount:', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  UI.setButtonLoading('#unshield-panel .submit-btn', true, 'Unshielding...');

  try {
    const amountWei = ethersLib.utils.parseEther(amountValue);
    const recipient = walletState.account;

    // Check private balance
    const privateBalance = await walletState.railgunWallet.getBalance(
      walletState.account,
      contracts.testERC20,
      0
    );
    
    if (privateBalance < amountWei.toBigInt()) {
      // toast.error(`Insufficient private balance!\n\nYour balance: ${ethersLib.utils.formatEther(privateBalance)} tokens\nRequired: ${amountValue} tokens`, 'Insufficient Balance');
      console.error('Insufficient Balance:', `Balance: ${ethersLib.utils.formatEther(privateBalance)}, Required: ${amountValue}`);
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

    // Call contract
    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    
    let gasLimit;
    try {
      gasLimit = await railgun.estimateGas.transact([formattedTransaction]);
      gasLimit = gasLimit.mul(120).div(100);
    } catch (error) {
      console.warn('Gas estimation failed:', error.message);
      gasLimit = ethersLib.BigNumber.from(10000000);
    }

    const tx = await railgun.transact([formattedTransaction], { gasLimit });
    
    addTransaction('unshield', 'Unshield', `Unshield ${amountValue} ${erc20TokenInfo.symbol}`, `-${amountValue} ${erc20TokenInfo.symbol}`, tx.hash, 'pending');
    // toast.txPending(tx.hash, `Unshielding ${amountValue} ${erc20TokenInfo.symbol}...`);

    await tx.wait();

    try {
      await walletState.railgunWallet.scanTransaction(tx.hash, walletState.account);
    } catch (scanError) {
      console.warn('Scan error (non-critical):', scanError.message);
    }

    updateTransactionStatus(tx.hash, 'success');
    await refreshBalances();
    
    // toast.txSuccess(`Successfully unshielded ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Unshield failed:', error);
    // toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#unshield-panel .submit-btn', false);
  }
}

// Transfer function
export async function handleTransfer(recipientAddress, amountValue) {
  if (!walletState.signer) {
    // toast.warning('Please connect your wallet first', 'Not Connected');
    console.warn('Not Connected: Please connect your wallet first');
    return;
  }

  try {
    validateAmount(amountValue);
  } catch (error) {
    // toast.error(error.message, 'Invalid Amount');
    console.error('Invalid Amount:', error.message);
    return;
  }

  const ethersLib = ensureEthers();
  
  if (!ethersLib.utils.isAddress(recipientAddress)) {
    // toast.error('Invalid recipient address', 'Invalid Address');
    console.error('Invalid Address: Invalid recipient address');
    return;
  }

  UI.setButtonLoading('#transfer-panel .submit-btn', true, 'Transferring...');

  try {
    // Import lookupMPK from wallet.js
    const { lookupMPK } = await import('./wallet.js');
    const userInfo = await lookupMPK(recipientAddress);
    
    if (!userInfo) {
      // toast.error(`Recipient is not registered!\n\nAddress: ${recipientAddress}\n\nPlease ask the recipient to register their MPK first.`, 'Recipient Not Registered');
      console.error('Recipient Not Registered:', recipientAddress);
      alert(`⚠️ Recipient is not registered!\n\nAddress: ${recipientAddress}\n\nThe recipient must register their MPK before receiving private transfers.\nPlease ask them to connect their wallet and register.`);
      return;
    }

    const amountWei = ethersLib.utils.parseEther(amountValue);

    const privateBalance = await walletState.railgunWallet.getBalance(
      walletState.account,
      contracts.testERC20,
      0
    );
    
    if (privateBalance < amountWei.toBigInt()) {
      // toast.error(`Insufficient private balance!\n\nYour balance: ${ethersLib.utils.formatEther(privateBalance)} tokens\nRequired: ${amountValue} tokens`, 'Insufficient Balance');
      console.error('Insufficient Balance:', `Balance: ${ethersLib.utils.formatEther(privateBalance)}, Required: ${amountValue}`);
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

    const railgun = new ethersLib.Contract(contracts.railgun, CONFIG.RAILGUN_ABI, walletState.signer);
    
    let gasLimit;
    try {
      gasLimit = await railgun.estimateGas.transact([formattedTransaction]);
      gasLimit = gasLimit.mul(120).div(100);
    } catch (error) {
      console.warn('Gas estimation failed:', error.message);
      gasLimit = ethersLib.BigNumber.from(10000000);
    }

    const tx = await railgun.transact([formattedTransaction], { gasLimit });
    
    const { formatAddress } = await import('./utils.js');
    addTransaction('transfer', 'Private Transfer', `To ${formatAddress(recipientAddress)}`, `-${amountValue} ${erc20TokenInfo.symbol}`, tx.hash, 'pending');
    // toast.txPending(tx.hash, `Transferring ${amountValue} ${erc20TokenInfo.symbol}...`);

    await tx.wait();

    try {
      await walletState.railgunWallet.scanTransaction(tx.hash, walletState.account);
      await walletState.railgunWallet.scanTransaction(tx.hash, recipientAddress, [{
        tokenType: 0,
        tokenAddress: contracts.testERC20,
        tokenSubID: 0n,
      }]);
    } catch (scanError) {
      console.warn('Scan error:', scanError.message);
    }

    updateTransactionStatus(tx.hash, 'success');
    await refreshBalances();
    
    // toast.txSuccess(`Successfully transferred ${amountValue} ${erc20TokenInfo.symbol}!`);

  } catch (error) {
    console.error('Transfer failed:', error);
    // toast.txFailed(error);
  } finally {
    UI.setButtonLoading('#transfer-panel .submit-btn', false);
  }
}
