/**
 * Bench Setup: Create wallets, shield notes, generate SNARK proofs, save to bench-proofs.json
 *
 * This runs once during 1-setup.sh. The output bench-proofs.json is consumed by
 * bench-submit.ts which can reuse the same proofs repeatedly (via debugResetBenchState).
 *
 * Usage:
 *   npx hardhat run scripts/bench-setup.ts --network localhost
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Wallet } from '../helpers/logic/wallet';
import { Note, TokenType, TokenData } from '../helpers/logic/note';
import { randomBytes } from '../helpers/global/crypto';
import { arrayToHexString, hexStringToArray } from '../helpers/global/bytes';
import { MerkleTree } from '../helpers/logic/merkletree';
import { transact, UnshieldType, PublicInputs } from '../helpers/logic/transaction';

// ============ Configuration (from .env) ============
const BENCH_WALLETS = parseInt(process.env.BENCH_WALLETS || '4', 10);
const BENCH_TOTAL_TXS = parseInt(process.env.BENCH_TOTAL_TXS || '20', 10);
const BENCH_TXS_PER_RELAY = parseInt(process.env.BENCH_TXS_PER_RELAY || '1', 10);

// ============ Internal constants ============
const INPUTS_PER_TX = 2;
const OUTPUTS_PER_TX = 2;
const NOTE_VALUE = 10n ** 18n;
const SHIELD_BATCH_SIZE = 50;
const ROOT_HISTORY_SIZE = 600;

// Auto-calculate notes needed per wallet
const NOTES_PER_WALLET = Math.ceil((BENCH_TOTAL_TXS * INPUTS_PER_TX) / BENCH_WALLETS) + 2;

// EIP-712 types for DelegateShield
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

// ============ Persistent tree state ============
interface TreeState {
  leaves: string[];
  zeros: string[];
  nullifiers: string[];
}

const TREE_STATE_PATH = path.join(__dirname, '../bench-tree.json');

function loadTreeState(): TreeState | null {
  if (fs.existsSync(TREE_STATE_PATH)) {
    return JSON.parse(fs.readFileSync(TREE_STATE_PATH, 'utf-8'));
  }
  return null;
}

function saveTreeState(merkletree: MerkleTree): void {
  const state: TreeState = {
    leaves: Array.from({ length: merkletree.tree[0].length }, (_, i) =>
      arrayToHexString(merkletree.tree[0][i], true),
    ),
    zeros: merkletree.zeros.map((z) => arrayToHexString(z, true)),
    nullifiers: merkletree.nullifiers.map((n) => arrayToHexString(n, true)),
  };
  fs.writeFileSync(TREE_STATE_PATH, JSON.stringify(state, null, 2));
}

// ============ Helpers ============

async function resolveProofRootIndex(railgun: any, merkletree: MerkleTree): Promise<number> {
  const chainRootIndex = await railgun.getCurrentRootIndex();
  const chainIndexNum = Number(chainRootIndex);
  const rootAtChainIndex = await railgun.roots(chainIndexNum);
  const localRootHex = arrayToHexString(merkletree.root, true);

  if (rootAtChainIndex.toLowerCase() === localRootHex.toLowerCase()) {
    return chainIndexNum;
  }
  const chainCurrentRoot = await railgun.getRoot();
  if (chainCurrentRoot.toLowerCase() === localRootHex.toLowerCase()) {
    return (chainIndexNum + 1) % ROOT_HISTORY_SIZE;
  }
  throw new Error(
    `Root mismatch: local=${localRootHex} roots(${chainIndexNum})=${rootAtChainIndex} getRoot()=${chainCurrentRoot}`,
  );
}

async function calculateBatchAdaptParams(
  merkletree: MerkleTree,
  txInputNotes: Note[][],
  actionData: any,
): Promise<Uint8Array> {
  const nullifiers2D: string[][] = [];
  for (const inputNotes of txInputNotes) {
    const txNullifiers: string[] = [];
    for (const note of inputNotes) {
      const noteHash = await note.getHash();
      const merkleProof = merkletree.generateProof(noteHash);
      const nullifier = await note.getNullifier(merkleProof.indices);
      txNullifiers.push(arrayToHexString(nullifier, true));
    }
    nullifiers2D.push(txNullifiers);
  }

  const encoded = ethers.utils.defaultAbiCoder.encode(
    [
      'bytes32[][]',
      'uint256',
      'tuple(bytes31 random, bool requireSuccess, uint256 minGasLimit, tuple(address to, bytes data, uint256 value)[] calls)',
    ],
    [nullifiers2D, txInputNotes.length, actionData],
  );
  return new Uint8Array(ethers.utils.arrayify(ethers.utils.keccak256(encoded)));
}

interface TransferPair {
  senderIdx: number;
  receiverIdx: number;
  inputNoteIndices: number[];
}

function generateTransferPairs(
  walletCount: number,
  txCount: number,
  unspentCounts: number[],
): TransferPair[] {
  const pairs: TransferPair[] = [];
  const consumed: number[] = new Array(walletCount).fill(0);

  for (let i = 0; i < txCount; i++) {
    const senderIdx = i % walletCount;
    const receiverIdx = (i + 1) % walletCount;

    const available = unspentCounts[senderIdx] - consumed[senderIdx];
    if (available < INPUTS_PER_TX) {
      console.warn(`  Warning: Wallet ${senderIdx} has ${available} notes left (need ${INPUTS_PER_TX}), skipping tx ${i}`);
      continue;
    }

    const inputNoteIndices: number[] = [];
    for (let j = 0; j < INPUTS_PER_TX; j++) {
      inputNoteIndices.push(consumed[senderIdx] + j);
    }
    consumed[senderIdx] += INPUTS_PER_TX;

    pairs.push({ senderIdx, receiverIdx, inputNoteIndices });
  }
  return pairs;
}

// ============ Serialization helpers ============

function toHex(arr: Uint8Array): string {
  return arrayToHexString(arr, true);
}

function bigintToStr(n: bigint): string {
  return n.toString();
}

function serializePublicInputs(pi: PublicInputs): any {
  return {
    proof: {
      a: { x: bigintToStr(pi.proof.a.x), y: bigintToStr(pi.proof.a.y) },
      b: {
        x: [bigintToStr(pi.proof.b.x[0]), bigintToStr(pi.proof.b.x[1])],
        y: [bigintToStr(pi.proof.b.y[0]), bigintToStr(pi.proof.b.y[1])],
      },
      c: { x: bigintToStr(pi.proof.c.x), y: bigintToStr(pi.proof.c.y) },
    },
    merkleRoot: toHex(pi.merkleRoot),
    rootIndex: pi.rootIndex,
    nullifiers: pi.nullifiers.map(toHex),
    commitments: pi.commitments.map(toHex),
    boundParams: {
      minGasPrice: bigintToStr(pi.boundParams.minGasPrice),
      unshield: pi.boundParams.unshield,
      chainID: bigintToStr(pi.boundParams.chainID),
      adaptContract: pi.boundParams.adaptContract,
      adaptParams: toHex(pi.boundParams.adaptParams),
      commitmentCiphertext: pi.boundParams.commitmentCiphertext.map((cc) => ({
        ciphertext: cc.ciphertext.map(toHex),
        blindedSenderViewingKey: toHex(cc.blindedSenderViewingKey),
        blindedReceiverViewingKey: toHex(cc.blindedReceiverViewingKey),
        annotationData: toHex(cc.annotationData),
        memo: toHex(cc.memo),
      })),
    },
    unshieldPreimage: {
      npk: toHex(pi.unshieldPreimage.npk),
      token: {
        tokenType: pi.unshieldPreimage.token.tokenType,
        tokenAddress: pi.unshieldPreimage.token.tokenAddress,
        tokenSubID: bigintToStr(pi.unshieldPreimage.token.tokenSubID),
      },
      value: bigintToStr(pi.unshieldPreimage.value),
    },
  };
}

// ============ Main ============

async function main() {
  console.log('============================================');
  console.log('  Bench Setup: Wallets + Shield + Proofs');
  console.log('============================================');
  console.log(`  Wallets: ${BENCH_WALLETS}`);
  console.log(`  Total TXs: ${BENCH_TOTAL_TXS}`);
  console.log(`  TXs per relay: ${BENCH_TXS_PER_RELAY}`);
  console.log(`  Circuit: ${INPUTS_PER_TX}-in / ${OUTPUTS_PER_TX}-out`);
  console.log('============================================\n');

  // ========== Load deployment config ==========
  const configPath = path.join(__dirname, '../deployments.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`deployments.json not found. Run contract deployment first.`);
  }
  const deployConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // ========== Connect contracts ==========
  const RailgunSmartWallet = await ethers.getContractFactory('RailgunSmartWalletStub', {
    libraries: { PoseidonT3: deployConfig.poseidonT3, PoseidonT4: deployConfig.poseidonT4 },
  });
  const railgun = RailgunSmartWallet.attach(deployConfig.proxy);
  const RelayAdapt = await ethers.getContractFactory('RelayAdapt');
  const relayAdapt = RelayAdapt.attach(deployConfig.relayAdaptProxy);
  const TestERC20 = await ethers.getContractFactory('TestERC20');
  const testERC20 = TestERC20.attach(deployConfig.testERC20);

  // ========== Get accounts ==========
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const broadcaster = signers[1];
  const user = signers[2];

  // Fund broadcaster and user if needed
  const MIN_ETH = ethers.utils.parseEther('1');
  for (const [name, account] of [['Broadcaster', broadcaster], ['User', user]] as const) {
    const balance = await account.getBalance();
    if (balance.lt(MIN_ETH)) {
      console.log(`Funding ${name} with 10 ETH...`);
      await (await deployer.sendTransaction({ to: account.address, value: ethers.utils.parseEther('10') })).wait();
    }
  }

  const tokenData: TokenData = {
    tokenType: TokenType.ERC20,
    tokenAddress: testERC20.address,
    tokenSubID: 0n,
  };

  // ========================================================
  // Phase 0: Create wallets, shield notes
  // ========================================================
  console.log('--- Phase 0: Setup (wallets + shield) ---\n');
  const setupStart = Date.now();

  // Load or create MerkleTree
  const savedTree = loadTreeState();
  let merkletree: MerkleTree;

  if (savedTree) {
    console.log('Loading MerkleTree from bench-tree.json...');
    const depth = 16;
    const zeros = savedTree.zeros.map((z) => hexStringToArray(z));
    const tree: Uint8Array[][] = Array(depth).fill(0).map(() => []);
    tree[depth] = [await MerkleTree.hashLeftRight(zeros[depth - 1], zeros[depth - 1])];
    for (let i = 0; i < savedTree.leaves.length; i++) {
      tree[0][i] = hexStringToArray(savedTree.leaves[i]);
    }
    merkletree = new MerkleTree(0, depth, zeros, tree);
    merkletree.nullifiers = savedTree.nullifiers.map((n) => hexStringToArray(n));
    await merkletree.rebuildSparseTree();
    console.log(`  Loaded: ${savedTree.leaves.length} leaves, ${savedTree.nullifiers.length} nullifiers`);
  } else {
    console.log('Creating fresh MerkleTree...');
    merkletree = await MerkleTree.createTree();
  }

  // Create fresh wallets
  console.log(`\nCreating ${BENCH_WALLETS} wallets...`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < BENCH_WALLETS; i++) {
    const w = new Wallet(randomBytes(32), randomBytes(32));
    w.tokens.push(tokenData);
    wallets.push(w);
  }

  // Mint tokens if needed
  const totalNotes = BENCH_WALLETS * NOTES_PER_WALLET;
  const totalTokensNeeded = NOTE_VALUE * BigInt(totalNotes);
  const userBalance = await testERC20.balanceOf(user.address);
  if (userBalance.lt(totalTokensNeeded)) {
    const mintAmount = ethers.BigNumber.from(totalTokensNeeded).sub(userBalance).add(ethers.utils.parseEther('1'));
    console.log(`Minting ${ethers.utils.formatEther(mintAmount)} tokens...`);
    await (await testERC20.mint(user.address, mintAmount)).wait();
  }

  // Approve if needed
  const allowance = await testERC20.allowance(user.address, relayAdapt.address);
  if (allowance.lt(totalTokensNeeded)) {
    await (await testERC20.connect(user).approve(relayAdapt.address, ethers.constants.MaxUint256)).wait();
  }

  // Shield notes for each wallet (parallel pipeline)
  console.log(`\nShielding ${NOTES_PER_WALLET} notes x ${BENCH_WALLETS} wallets = ${totalNotes} notes...`);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: 'RelayAdapt',
    version: '1',
    chainId,
    verifyingContract: relayAdapt.address,
  };
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  let totalShieldGas = ethers.BigNumber.from(0);

  // Step 1: Create all notes for all wallets
  interface ShieldBatch {
    walletIdx: number;
    notes: Note[];
    contractNonceStart: any;
  }

  const allShieldBatches: ShieldBatch[] = [];
  let contractNonceOffset = 0;
  const baseContractNonce = await relayAdapt.getNonce(user.address);

  for (let walletIdx = 0; walletIdx < BENCH_WALLETS; walletIdx++) {
    const wallet = wallets[walletIdx];
    const walletNotes: Note[] = [];
    for (let i = 0; i < NOTES_PER_WALLET; i++) {
      walletNotes.push(new Note(wallet.spendingKey, wallet.viewingKey, NOTE_VALUE, randomBytes(16), tokenData, ''));
    }
    for (let batchStart = 0; batchStart < walletNotes.length; batchStart += SHIELD_BATCH_SIZE) {
      const batchNotes = walletNotes.slice(batchStart, batchStart + SHIELD_BATCH_SIZE);
      allShieldBatches.push({
        walletIdx,
        notes: batchNotes,
        contractNonceStart: baseContractNonce.add(contractNonceOffset),
      });
      contractNonceOffset += batchNotes.length;
    }
  }
  console.log(`  ${allShieldBatches.length} shield batches prepared (batch size up to ${SHIELD_BATCH_SIZE})`);

  // Step 2: Encrypt + sign all batches in parallel
  console.log('  Encrypting & signing...');
  const preparedBatches = await Promise.all(
    allShieldBatches.map(async (batch) => {
      const shieldRequests = await Promise.all(batch.notes.map((n) => n.encryptForShield()));
      const delegateShieldRequests = [];
      const signatures = [];
      for (let i = 0; i < shieldRequests.length; i++) {
        const req = shieldRequests[i];
        const nonce = batch.contractNonceStart.add(i);
        const message = {
          npk: req.preimage.npk,
          tokenAddress: req.preimage.token.tokenAddress,
          tokenType: req.preimage.token.tokenType,
          tokenSubID: req.preimage.token.tokenSubID,
          value: req.preimage.value,
          encryptedBundle0: req.ciphertext.encryptedBundle[0],
          encryptedBundle1: req.ciphertext.encryptedBundle[1],
          encryptedBundle2: req.ciphertext.encryptedBundle[2],
          shieldKey: req.ciphertext.shieldKey,
          from: user.address,
          nonce,
          deadline,
        };
        signatures.push(await user._signTypedData(domain, DELEGATE_SHIELD_TYPES, message));
        delegateShieldRequests.push({ shieldRequest: req, from: user.address, nonce, deadline });
      }
      return { delegateShieldRequests, signatures, walletIdx: batch.walletIdx };
    }),
  );
  console.log('  All batches encrypted & signed');

  // Step 3: Submit all delegateShield calls with managed broadcaster nonces
  const SHIELD_GAS_LIMIT = 15_000_000;
  console.log('  Submitting all shield txs...');
  const shieldBaseTxNonce = await broadcaster.getTransactionCount('pending');
  const shieldTxResponses = await Promise.all(
    preparedBatches.map(async (p, i) => {
      return relayAdapt.connect(broadcaster).delegateShield(
        p.delegateShieldRequests,
        p.signatures,
        { nonce: shieldBaseTxNonce + i, gasLimit: SHIELD_GAS_LIMIT },
      );
    }),
  );

  // Step 4: Wait for all receipts
  console.log(`  Waiting for ${shieldTxResponses.length} confirmations...`);
  const shieldReceipts = await Promise.all(shieldTxResponses.map((tx) => tx.wait()));
  for (const receipt of shieldReceipts) {
    totalShieldGas = totalShieldGas.add(receipt.gasUsed);
  }

  // Step 5: Scan all TXs sequentially (order matters for merkle tree)
  console.log('  Scanning shield events...');
  for (let i = 0; i < shieldTxResponses.length; i++) {
    const wIdx = allShieldBatches[i].walletIdx;
    await merkletree.scanTX(shieldTxResponses[i], railgun);
    await wallets[wIdx].scanTX(shieldTxResponses[i], railgun);
  }

  for (let i = 0; i < BENCH_WALLETS; i++) {
    console.log(`  Wallet ${i}: ${wallets[i].notes.filter(Boolean).length} notes shielded`);
  }

  const setupEnd = Date.now();
  console.log(`\nSetup complete: ${totalNotes} notes shielded in ${setupEnd - setupStart}ms (gas: ${totalShieldGas.toString()})`);

  // Save tree state
  saveTreeState(merkletree);
  console.log('MerkleTree state saved to bench-tree.json');

  // ========================================================
  // Phase 1: Generate proofs
  // ========================================================
  console.log('\n--- Phase 1: Generate SNARK Proofs ---\n');

  const chainID = BigInt(chainId);
  const rootIndex = await resolveProofRootIndex(railgun, merkletree);
  const rootHex = arrayToHexString(merkletree.root, true);
  console.log(`Root index: ${rootIndex}, root: ${rootHex}`);

  // Get unspent notes per wallet
  const unspentNotesPerWallet: Note[][] = [];
  for (let i = 0; i < wallets.length; i++) {
    const unspent = await wallets[i].getUnspentNotes(merkletree, tokenData);
    unspentNotesPerWallet.push(unspent);
    console.log(`  Wallet ${i}: ${unspent.length} unspent notes`);
  }

  // Generate transfer pairs
  const pairs = generateTransferPairs(
    wallets.length,
    BENCH_TOTAL_TXS,
    unspentNotesPerWallet.map((n) => n.length),
  );
  const actualTxCount = pairs.length;
  console.log(`\nTransfer pairs: ${actualTxCount} (round-robin)`);

  if (actualTxCount === 0) {
    throw new Error('No transactions to benchmark! Not enough notes.');
  }

  // Group into relay batches
  const relayBatches: TransferPair[][] = [];
  for (let i = 0; i < actualTxCount; i += BENCH_TXS_PER_RELAY) {
    relayBatches.push(pairs.slice(i, i + BENCH_TXS_PER_RELAY));
  }
  console.log(`Relay batches: ${relayBatches.length} (${BENCH_TXS_PER_RELAY} tx/batch)`);

  // Prepare inputs/outputs for all batches
  interface BatchData {
    inputNotesList: Note[][];
    outputNotesList: Note[][];
    adaptParams: Uint8Array;
    actionData: any;
  }

  console.log('\nPreparing batch data (adaptParams)...');
  const batchDataList: BatchData[] = await Promise.all(
    relayBatches.map(async (batch) => {
      const inputNotesList: Note[][] = [];
      const outputNotesList: Note[][] = [];

      for (const pair of batch) {
        const receiver = wallets[pair.receiverIdx];
        const senderUnspent = unspentNotesPerWallet[pair.senderIdx];
        const inputNotes = pair.inputNoteIndices.map((idx) => senderUnspent[idx]);
        const inputTotal = inputNotes.reduce((sum, n) => sum + n.value, 0n);
        const perNote = inputTotal / BigInt(OUTPUTS_PER_TX);
        const remainder = inputTotal % BigInt(OUTPUTS_PER_TX);

        const outputNotes: Note[] = [];
        for (let j = 0; j < OUTPUTS_PER_TX; j++) {
          outputNotes.push(
            new Note(receiver.spendingKey, receiver.viewingKey, j === 0 ? perNote + remainder : perNote, randomBytes(16), tokenData, ''),
          );
        }
        inputNotesList.push(inputNotes);
        outputNotesList.push(outputNotes);
      }

      const actionData = {
        random: ethers.utils.hexlify(randomBytes(31)),
        requireSuccess: true,
        minGasLimit: 0,
        calls: [] as { to: string; data: string; value: any }[],
      };
      const adaptParams = await calculateBatchAdaptParams(merkletree, inputNotesList, actionData);
      return { inputNotesList, outputNotesList, adaptParams, actionData };
    }),
  );
  console.log(`  ${batchDataList.length} batches prepared`);

  // Flatten all proof tasks across all batches
  interface ProofTask {
    batchIdx: number;
    txIdx: number;
    inputNotes: Note[];
    outputNotes: Note[];
    adaptParams: Uint8Array;
  }

  const allProofTasks: ProofTask[] = [];
  for (let batchIdx = 0; batchIdx < batchDataList.length; batchIdx++) {
    const bd = batchDataList[batchIdx];
    for (let txIdx = 0; txIdx < bd.inputNotesList.length; txIdx++) {
      allProofTasks.push({
        batchIdx,
        txIdx,
        inputNotes: bd.inputNotesList[txIdx],
        outputNotes: bd.outputNotesList[txIdx],
        adaptParams: bd.adaptParams,
      });
    }
  }

  // Concurrency-limited proof generation
  const PROOF_CONCURRENCY = Math.max(1, os.cpus().length);
  console.log(`\nGenerating ${allProofTasks.length} proofs (concurrency: ${PROOF_CONCURRENCY})...`);

  const proofTimings: number[] = new Array(allProofTasks.length);
  const proofResults: PublicInputs[] = new Array(allProofTasks.length);
  let proofsDone = 0;
  const proofPhaseStart = Date.now();

  // Worker pool pattern: N workers pulling from a shared task queue
  let taskCursor = 0;
  const proofWorker = async () => {
    while (taskCursor < allProofTasks.length) {
      const idx = taskCursor++;
      const task = allProofTasks[idx];
      const txStart = Date.now();
      proofResults[idx] = await transact(
        merkletree, rootIndex, 0n, UnshieldType.NONE, chainID,
        relayAdapt.address, task.adaptParams, task.inputNotes, task.outputNotes,
      );
      const elapsed = Date.now() - txStart;
      proofTimings[idx] = elapsed;
      proofsDone++;
      if (proofsDone % 50 === 0 || proofsDone === allProofTasks.length) {
        console.log(`  ${proofsDone}/${allProofTasks.length} proofs done (last: ${elapsed}ms)`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROOF_CONCURRENCY, allProofTasks.length) }, () => proofWorker()),
  );

  // Group proof results back into batches
  const allBatchTransactions: PublicInputs[][] = batchDataList.map(() => []);
  for (let i = 0; i < allProofTasks.length; i++) {
    const task = allProofTasks[i];
    allBatchTransactions[task.batchIdx][task.txIdx] = proofResults[i];
  }

  const proofPhaseTotal = Date.now() - proofPhaseStart;
  const validTimings = proofTimings.filter((t) => t !== undefined);
  const avgProof = validTimings.length > 0 ? validTimings.reduce((a, b) => a + b, 0) / validTimings.length : 0;
  console.log(`\nProof phase: ${proofPhaseTotal}ms total, ${avgProof.toFixed(0)}ms avg, ${Math.min(...validTimings)}ms min, ${Math.max(...validTimings)}ms max`);

  // ========================================================
  // Serialize and save to bench-proofs.json
  // ========================================================
  console.log('\n--- Saving proofs to bench-proofs.json ---\n');

  // Collect all nullifiers across all proofs (flat list for debugResetBenchState)
  const allNullifiers: string[] = [];
  for (const pi of proofResults) {
    for (const n of pi.nullifiers) {
      allNullifiers.push(toHex(n));
    }
  }

  const benchProofs = {
    config: {
      wallets: BENCH_WALLETS,
      totalTxs: actualTxCount,
      txsPerRelay: BENCH_TXS_PER_RELAY,
      inputsPerTx: INPUTS_PER_TX,
      outputsPerTx: OUTPUTS_PER_TX,
    },
    rootIndex,
    root: rootHex,
    nullifiers: allNullifiers,
    batches: allBatchTransactions.map((batchTxs, batchIdx) => ({
      transactions: batchTxs.map(serializePublicInputs),
      actionData: batchDataList[batchIdx].actionData,
    })),
    proofStats: {
      totalMs: proofPhaseTotal,
      avgMs: Math.round(avgProof),
      minMs: Math.min(...validTimings),
      maxMs: Math.max(...validTimings),
    },
    setupStats: {
      shieldGas: totalShieldGas.toString(),
      notesCreated: totalNotes,
      durationMs: setupEnd - setupStart,
    },
  };

  const proofsPath = path.join(__dirname, '../bench-proofs.json');
  fs.writeFileSync(proofsPath, JSON.stringify(benchProofs));
  const fileSizeMB = (fs.statSync(proofsPath).size / 1024 / 1024).toFixed(1);
  console.log(`Saved: bench-proofs.json (${fileSizeMB} MB)`);
  console.log(`  ${allBatchTransactions.length} batches, ${actualTxCount} transactions`);
  console.log(`  ${allNullifiers.length} nullifiers to reset`);

  console.log('\n============================================');
  console.log('  Bench Setup Complete!');
  console.log('  Proofs: bench-proofs.json');
  console.log('  Tree:   bench-tree.json');
  console.log('  Now run: ./2-bench.sh');
  console.log('============================================');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
