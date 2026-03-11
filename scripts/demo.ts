import { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from '../helpers/logic/wallet';
import { Note, TokenType } from '../helpers/logic/note';
import { randomBytes } from '../helpers/global/crypto';
import { arrayToHexString } from '../helpers/global/bytes';
import { MerkleTree } from '../helpers/logic/merkletree';
import { UnshieldType } from '../helpers/logic/transaction';
import { ActionData, Call, transactWithAdaptParams } from '../helpers/adapt/relay';
import { RailgunSmartWalletStub } from '../typechain-types';

/** Must match Commitments.sol ROOT_HISTORY_SIZE (lazy root: proof uses next slot) */
const ROOT_HISTORY_SIZE = 100;

/** Default gas limit for relay transactions */
const DEFAULT_GAS_LIMIT = 5_000_000;

/** Default deadline duration in seconds (1 hour) */
const DEADLINE_DURATION = 3600;

/**
 * Resolve proof root index using contract's findRoot method.
 * Falls back to checking getRoot() for lazy update scenario.
 */
async function resolveProofRootIndex(
  railgun: RailgunSmartWalletStub,
  merkletree: MerkleTree,
  logPrefix: string
): Promise<number> {
  const localRootHex = arrayToHexString(merkletree.root, true);
  
  // Try to find root in history using contract's findRoot
  const [exists, rootIndex] = await railgun.findRoot(merkletree.treeNumber, localRootHex);
  
  if (exists) {
    console.log(`📦 [${logPrefix}] findRoot found root at index ${rootIndex}`);
    return rootIndex;
  }

  // Fallback: check if it's a lazy update scenario (root not yet written to history)
  const chainCurrentRoot = await railgun.getRoot();
  if (chainCurrentRoot.toLowerCase() === localRootHex.toLowerCase()) {
    const chainRootIndex = await railgun.getCurrentRootIndex();
    const proofIndex = (Number(chainRootIndex) + 1) % ROOT_HISTORY_SIZE;
    console.log(`📦 [${logPrefix}] lazy update: getRoot() matches → proof rootIndex=${proofIndex}`);
    return proofIndex;
  }

  throw new Error(
    `Local root not found on chain: local=${localRootHex} getRoot()=${chainCurrentRoot}`
  );
}

/**
 * Log gas used information from transaction receipt
 */
function logGasUsed(receipt: ContractReceipt, transactionName: string): void {
  console.log(`\n⛽ ${transactionName} Gas Used: ${receipt.gasUsed.toString()}`);
}

/**
 * Log transaction hash and block number for debugging (e.g. same-block root timing)
 */
function logTxBlock(receipt: ContractReceipt, transactionName: string): void {
  console.log(`📦 [${transactionName}] blockNumber=${receipt.blockNumber} txHash=${receipt.transactionHash}`);
}

/**
 * Create empty ActionData for relay transactions
 */
function createEmptyActionData(): ActionData {
  return {
    random: randomBytes(31),
    requireSuccess: true,
    minGasLimit: 0n,
    calls: [] as Call[],
  };
}

/**
 * Scan transaction with merkletree and wallets
 */
async function scanTransaction(
  tx: ContractTransaction,
  railgun: RailgunSmartWalletStub,
  merkletree: MerkleTree,
  wallets: Wallet[]
): Promise<void> {
  await merkletree.scanTX(tx, railgun);
  await Promise.all(wallets.map((w) => w.scanTX(tx, railgun)));
}

/**
 * Interaction script - Connect to deployed contracts for testing
 * 
 * Architecture:
 * - broadcaster (account 1): Submits delegateShield and relay transactions
 * - user (account 2): End user who wants to shield/transact
 * 
 * Note: After deployment, all contract ownerships are transferred to governance contracts.
 * The deployer (account 0) no longer has special permissions.
 *
 * Usage:
 * 1. Ensure hardhat node is running
 * 2. Ensure contracts are deployed via yarn deploy (generates deployments.json automatically)
 * 3. Run: npx hardhat run scripts/demo.ts --network localhost
 */

// EIP-712 type definitions for DelegateShield
const DELEGATE_SHIELD_TYPES = {
  DelegateShield: [
    { name: 'npk', type: 'bytes32' },
    { name: 'tokenAddress', type: 'address' },
    { name: 'tokenType', type: 'uint8' },
    { name: 'tokenSubID', type: 'uint256' },
    { name: 'value', type: 'uint120' },
    { name: 'encryptedBundle0', type: 'bytes32' },
    { name: 'encryptedBundle1', type: 'bytes32' },
    { name: 'encryptedBundle2', type: 'bytes32' },
    { name: 'shieldKey', type: 'bytes32' },
    { name: 'from', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

async function main() {
  // ========== Read deployment config from JSON file ==========
  const configPath = path.join(__dirname, '../deployments.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Deployment config file not found: ${configPath}\n` +
      'Please run: yarn deploy'
    );
  }

  const deployConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const RAILGUN_SMART_WALLET_ADDRESS = deployConfig.proxy;
  const RELAY_ADAPT_ADDRESS = deployConfig.relayAdaptProxy;
  const TEST_ERC20_ADDRESS = deployConfig.testERC20;
  const POSEIDON_T3_ADDRESS = deployConfig.poseidonT3;
  const POSEIDON_T4_ADDRESS = deployConfig.poseidonT4;

  console.log('📋 Reading config from deployments.json:');
  console.log('  RailgunSmartWallet (proxy):', RAILGUN_SMART_WALLET_ADDRESS);
  console.log('  RelayAdapt (proxy):', RELAY_ADAPT_ADDRESS);
  console.log('  TestERC20:', TEST_ERC20_ADDRESS);
  console.log('  PoseidonT3:', POSEIDON_T3_ADDRESS);
  console.log('  PoseidonT4:', POSEIDON_T4_ADDRESS);

  // ========== Get accounts ==========
  // broadcaster (1): submits tx, user (2): end user
  const signers = await ethers.getSigners();
  const broadcaster = signers[1];
  const user = signers[2];
  
  console.log('\n=== Accounts ===');
  console.log('Broadcaster:', broadcaster.address);
  console.log('User:', user.address);

  // ========== Connect to deployed contracts ==========
  // Get RailgunSmartWallet factory with library links
  const RailgunSmartWallet = await ethers.getContractFactory('RailgunSmartWalletStub', {
    libraries: {
      PoseidonT3: POSEIDON_T3_ADDRESS,
      PoseidonT4: POSEIDON_T4_ADDRESS,
    },
  });
  const railgun = RailgunSmartWallet.attach(RAILGUN_SMART_WALLET_ADDRESS) as RailgunSmartWalletStub;

  const RelayAdapt = await ethers.getContractFactory('RelayAdapt');
  const relayAdapt = RelayAdapt.attach(RELAY_ADAPT_ADDRESS);

  const TestERC20 = await ethers.getContractFactory('TestERC20');
  const testERC20 = TestERC20.attach(TEST_ERC20_ADDRESS);

  console.log('\n=== Contract Addresses ===');
  console.log('RailgunSmartWallet:', railgun.address);
  console.log('RelayAdapt:', relayAdapt.address);
  console.log('TestERC20:', testERC20.address);

  // ========== Check RelayAdapt configuration ==========
  console.log('\n=== RelayAdapt Config ===');
  const configuredBroadcaster = await relayAdapt.broadcaster();
  console.log('Configured Broadcaster:', configuredBroadcaster);
  console.log('Broadcaster matches:', configuredBroadcaster === broadcaster.address);

  // ========== Prepare tokens for user ==========
  console.log('\n=== Preparing Tokens for User ===');
  
  // Mint tokens to user
  const userBalance = await testERC20.balanceOf(user.address);
  console.log('User ERC20 balance:', ethers.utils.formatEther(userBalance));

  if (userBalance.lt(ethers.utils.parseEther('5'))) {
    console.log('Minting tokens to user...');
    await (await testERC20.mint(user.address, ethers.utils.parseEther('10'))).wait();
    console.log('New user balance:', ethers.utils.formatEther(await testERC20.balanceOf(user.address)));
  }

  // User approves RelayAdapt (not RailgunSmartWallet directly)
  const allowance = await testERC20.allowance(user.address, relayAdapt.address);
  if (allowance.lt(ethers.utils.parseEther('5'))) {
    console.log('User approving tokens to RelayAdapt...');
    await (await testERC20.connect(user).approve(relayAdapt.address, ethers.constants.MaxUint256)).wait();
    console.log('Approval complete');
  }

  // ========== Example 1: Shield ERC20 via DelegateShield ==========
  console.log('\n=== Example 1: Shield ERC20 via DelegateShield ===');

  // 1.1 Create merkle tree and wallet
  const merkletree = await MerkleTree.createTree();
  const wallet1 = new Wallet(randomBytes(32), randomBytes(32));
  console.log('MerkleTree created');
  console.log('Wallet1 created');

  // 1.2 Prepare token data
  const tokenData = {
    tokenType: TokenType.ERC20,
    tokenAddress: testERC20.address,
    tokenSubID: 0n,
  };
  wallet1.tokens.push(tokenData);

  // 1.3 Create multiple notes for shield
  const shieldNotes = [
    new Note(wallet1.spendingKey, wallet1.viewingKey, 10n ** 18n, randomBytes(16), tokenData, ''),
    new Note(wallet1.spendingKey, wallet1.viewingKey, 10n ** 18n, randomBytes(16), tokenData, ''),
    new Note(wallet1.spendingKey, wallet1.viewingKey, 10n ** 18n, randomBytes(16), tokenData, ''),
  ];

  // 1.4 Encrypt notes for shield
  const shieldRequests = await Promise.all(
    shieldNotes.map((note) => note.encryptForShield())
  );
  console.log('Shield requests prepared:', shieldRequests.length);

  // 1.5 Get user's nonce from RelayAdapt
  const userNonce = await relayAdapt.getNonce(user.address);
  console.log('User nonce:', userNonce.toString());

  // 1.6 Prepare EIP-712 domain
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: 'RelayAdapt',
    version: '1',
    chainId: chainId,
    verifyingContract: relayAdapt.address,
  };

  // 1.7 Prepare DelegateShieldRequests and signatures
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_DURATION;
  const delegateShieldRequests = [];
  const signatures = [];

  for (let i = 0; i < shieldRequests.length; i++) {
    const shieldReq = shieldRequests[i];
    const nonce = userNonce.add(i);

    // Prepare message for signing
    const message = {
      npk: shieldReq.preimage.npk,
      tokenAddress: shieldReq.preimage.token.tokenAddress,
      tokenType: shieldReq.preimage.token.tokenType,
      tokenSubID: shieldReq.preimage.token.tokenSubID,
      value: shieldReq.preimage.value,
      encryptedBundle0: shieldReq.ciphertext.encryptedBundle[0],
      encryptedBundle1: shieldReq.ciphertext.encryptedBundle[1],
      encryptedBundle2: shieldReq.ciphertext.encryptedBundle[2],
      shieldKey: shieldReq.ciphertext.shieldKey,
      from: user.address,
      nonce: nonce,
      deadline: deadline,
    };

    // User signs the message
    const signature = await user._signTypedData(domain, DELEGATE_SHIELD_TYPES, message);
    signatures.push(signature);

    // Prepare DelegateShieldRequest struct
    delegateShieldRequests.push({
      shieldRequest: shieldReq,
      from: user.address,
      nonce: nonce,
      deadline: deadline,
    });
  }

  console.log('Signatures generated:', signatures.length);

  // 1.8 Broadcaster calls delegateShield
  console.log('Broadcaster executing delegateShield...');
  const shieldTx = await relayAdapt.connect(broadcaster).delegateShield(
    delegateShieldRequests,
    signatures
  );
  const shieldReceipt = await shieldTx.wait();
  logTxBlock(shieldReceipt, 'DelegateShield');
  logGasUsed(shieldReceipt, 'DelegateShield');

  // ========== (Optional) Query Shield Events ==========
  /*
  console.log('\nQuerying Shield Events...');
  const shieldFilter = railgun.filters.Shield();
  const shieldEvents = await railgun.queryFilter(shieldFilter, shieldReceipt.blockNumber);
  console.log('Shield events found:', shieldEvents.length);
  if (shieldEvents.length > 0) {
    const event = shieldEvents[0];
    console.log('Tree number:', event.args.treeNumber.toString());
    console.log('Start position:', event.args.startPosition.toString());
    console.log('Commitments count:', event.args.commitments.length);
  }
  */

  // 1.9 Scan transaction (wallet side)
  console.log('\nScanning transaction...');
  await scanTransaction(shieldTx, railgun, merkletree, [wallet1]);
  console.log('Wallet1 notes count:', wallet1.notes.length);

  if (wallet1.notes.length > 0) {
    const note = wallet1.notes[0];
    console.log('Note value:', note.value.toString());
    console.log('Note token:', note.tokenData.tokenAddress);
  }

  // ========== Example 2: Private Transfer via Relay ==========
  console.log('\n=== Example 2: Private Transfer via Relay ===');

  // 2.1 Create second wallet (receiver)
  const wallet2 = new Wallet(randomBytes(32), randomBytes(32));
  wallet2.tokens.push(tokenData);
  console.log('Wallet2 (receiver) created');

  // 2.2 Get chain ID
  const chainID = BigInt((await ethers.provider.send('eth_chainId', [])) as string);

  // 2.3 Get transfer transaction inputs and outputs
  const transferNotes = await wallet1.getTestTransactionInputs(
    merkletree,
    2, // 2 input notes
    3, // 3 output notes
    false, // no unshield
    tokenData,
    wallet2.spendingKey, // receiver spending key
    wallet2.viewingKey, // receiver viewing key
  );

  const inputNotes = transferNotes.inputs;
  const outputNotes = transferNotes.outputs;

  console.log('Transfer inputs:', inputNotes.length);
  console.log('Transfer outputs:', outputNotes.length);

  // 2.4 Get root index: chain roots(chainIndex) vs local root; if lazy, chain getRoot() vs local → index+1
  const blockAtRootQuery = await ethers.provider.getBlockNumber();
  const rootIndex = await resolveProofRootIndex(railgun, merkletree, 'before Transfer');
  console.log(`📦 [before Transfer] blockNumber=${blockAtRootQuery} (shield was in block ${shieldReceipt.blockNumber})`);

  // 2.5 Prepare actionData
  const actionData = createEmptyActionData();

  // 2.6 Generate SNARK proof with correct adaptParams using transactWithAdaptParams
  console.log('Generating SNARK proof (this may take a moment)...');
  const proofStartTime = Date.now();
  const [transferTransaction] = await transactWithAdaptParams(
    merkletree,
    merkletree.treeNumber,
    rootIndex,
    actionData,
    [{
      minGasPrice: 0n,
      unshield: UnshieldType.NONE,
      chainID,
      adaptContract: relayAdapt.address,
      notesIn: inputNotes,
      notesOut: outputNotes,
    }],
  );
  const proofEndTime = Date.now();
  console.log(`✅ SNARK proof generated (${proofEndTime - proofStartTime}ms)`);

  // 2.7 Broadcaster executes relay
  console.log('\nBroadcaster executing relay...');

  const transferTx = await relayAdapt.connect(broadcaster).relay(
    [transferTransaction],
    actionData,
    { gasLimit: DEFAULT_GAS_LIMIT }
  );
  const relayReceipt = await transferTx.wait();
  logTxBlock(relayReceipt, 'Relay (Transfer)');
  logGasUsed(relayReceipt, 'Relay (Transfer)');

  // 2.8 Scan transfer transaction
  await scanTransaction(transferTx, railgun, merkletree, [wallet1, wallet2]);

  // 2.9 Check balances
  const wallet1Balance = await wallet1.getBalance(merkletree, tokenData);
  const wallet2Balance = await wallet2.getBalance(merkletree, tokenData);
  console.log('Wallet1 balance after transfer:', wallet1Balance.toString());
  console.log('Wallet2 balance after transfer:', wallet2Balance.toString());

  // ========== Example 3: Unshield via Relay ==========
  console.log('\n=== Example 3: Unshield via Relay ===');

  // 3.1 Get unshield transaction inputs and outputs
  const unshieldNotes = await wallet2.getTestTransactionInputs(
    merkletree,
    2, // 2 input notes
    3, // 3 output notes (last one will be unshield)
    user.address, // unshield to user's address
    tokenData,
    wallet2.spendingKey,
    wallet2.viewingKey,
  );

  console.log('Unshield inputs:', unshieldNotes.inputs.length);
  console.log('Unshield outputs:', unshieldNotes.outputs.length);
  console.log('Unshield to address:', user.address);

  // 3.2 Prepare actionData
  const unshieldActionData = createEmptyActionData();

  // 3.3 Get root index: chain roots(chainIndex) vs local root; if lazy, chain getRoot() vs local → index+1
  const blockAtUnshieldRootQuery = await ethers.provider.getBlockNumber();
  const unshieldRootIndex = await resolveProofRootIndex(railgun, merkletree, 'before Unshield');
  console.log(`📦 [before Unshield] blockNumber=${blockAtUnshieldRootQuery}`);

  // 3.4 Generate SNARK proof with correct adaptParams using transactWithAdaptParams
  console.log('Generating SNARK proof for unshield...');
  const unshieldProofStart = Date.now();
  const [unshieldTransaction] = await transactWithAdaptParams(
    merkletree,
    merkletree.treeNumber,
    unshieldRootIndex,
    unshieldActionData,
    [{
      minGasPrice: 0n,
      unshield: UnshieldType.NORMAL,
      chainID,
      adaptContract: relayAdapt.address,
      notesIn: unshieldNotes.inputs,
      notesOut: unshieldNotes.outputs,
    }],
  );
  const unshieldProofEnd = Date.now();
  console.log(`✅ SNARK proof generated (${unshieldProofEnd - unshieldProofStart}ms)`);

  // 3.5 Broadcaster executes relay for unshield
  console.log('\nBroadcaster executing relay for unshield...');

  const unshieldTx = await relayAdapt.connect(broadcaster).relay(
    [unshieldTransaction],
    unshieldActionData,
    { gasLimit: DEFAULT_GAS_LIMIT }
  );
  const unshieldReceipt = await unshieldTx.wait();
  logTxBlock(unshieldReceipt, 'Relay (Unshield)');
  logGasUsed(unshieldReceipt, 'Relay (Unshield)');

  // 3.6 Check token balance of user
  const userFinalBalance = await testERC20.balanceOf(user.address);
  console.log('User ERC20 balance after unshield:', ethers.utils.formatEther(userFinalBalance));

  // 3.7 Scan unshield transaction
  await scanTransaction(unshieldTx, railgun, merkletree, [wallet1, wallet2]);

  // 3.8 Check final balances
  const wallet1FinalBalance = await wallet1.getBalance(merkletree, tokenData);
  const wallet2FinalBalance = await wallet2.getBalance(merkletree, tokenData);
  console.log('Wallet1 final balance:', wallet1FinalBalance.toString());
  console.log('Wallet2 final balance:', wallet2FinalBalance.toString());

  // ========== (Optional) Query Transact Events ==========
  /*
  console.log('\n=== Query Transact Events ===');
  const transactFilter = railgun.filters.Transact();
  const transactEvents = await railgun.queryFilter(transactFilter, shieldReceipt.blockNumber);
  console.log('Transact events found:', transactEvents.length);

  if (transactEvents.length > 0) {
    transactEvents.forEach((event, index) => {
      console.log(`\nTransact Event ${index + 1}:`);
      console.log('  Tree number:', event.args.treeNumber.toString());
      console.log('  Start position:', event.args.startPosition.toString());
      console.log('  Commitments count:', event.args.hash.length);
      console.log('  Block number:', event.blockNumber);
    });
  }
  */

  console.log('\n=== Test Complete ===');
  console.log('Summary:');
  console.log('  - User shielded 3 tokens via delegateShield');
  console.log('  - Wallet1 transferred to Wallet2 via relay');
  console.log('  - Wallet2 unshielded to user address via relay');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
