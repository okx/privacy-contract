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
import * as crypto from 'crypto';
import { fork, ChildProcess } from 'child_process';
import { Wallet } from '../helpers/logic/wallet';
import { Note, TokenType, TokenData, getTokenID } from '../helpers/logic/note';
import { randomBytes, hash as cryptoHash } from '../helpers/global/crypto';
import { arrayToHexString, hexStringToArray, bigIntToArray } from '../helpers/global/bytes';
import { MerkleTree } from '../helpers/logic/merkletree';
import { getKeys } from '../helpers/logic/artifacts';

// ============ Configuration (from .env) ============
const BENCH_USERS = parseInt(process.env.BENCH_USERS || '4', 10);
const BENCH_TOTAL_UOP = parseInt(process.env.BENCH_TOTAL_UOP || '20', 10);
const BENCH_BATCH_COUNT = parseInt(process.env.BENCH_BATCH_COUNT || '1', 10);
const BENCH_BROADCASTER_COUNT = parseInt(process.env.BENCH_BROADCASTER_COUNT || '1', 10);

// ============ Internal constants ============
const INPUTS_PER_TX = 2;
const OUTPUTS_PER_TX = 2;
const NOTE_VALUE = 10n ** 18n;
const SHIELD_BATCH_SIZE = 50;
const ROOT_HISTORY_SIZE = 600;

// Auto-calculate notes needed per wallet
const NOTES_PER_WALLET = Math.ceil((BENCH_TOTAL_UOP * INPUTS_PER_TX) / BENCH_USERS) + 2;

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

// ============ Broadcaster key derivation ============

function deriveBroadcasterKey(masterKey: string, index: number): string {
  return '0x' + crypto.createHash('sha256')
    .update(masterKey + '_bench_broadcaster_' + index)
    .digest('hex');
}

// ============ Main ============

async function main() {
  console.log('============================================');
  console.log('  Bench Setup: Wallets + Shield + Proofs');
  console.log('============================================');
  console.log(`  Users: ${BENCH_USERS}`);
  console.log(`  Total UOps: ${BENCH_TOTAL_UOP}`);
  console.log(`  Batch count: ${BENCH_BATCH_COUNT}`);
  console.log(`  Broadcasters: ${BENCH_BROADCASTER_COUNT}`);
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

  // Fund N bench broadcaster wallets (for multi-broadcaster submit)
  const masterKey = process.env.PRIVATE_KEY!;
  if (BENCH_BROADCASTER_COUNT > 0) {
    console.log(`\nFunding ${BENCH_BROADCASTER_COUNT} bench broadcaster wallet(s)...`);
    const fundAmount = ethers.utils.parseEther('100');
    for (let i = 0; i < BENCH_BROADCASTER_COUNT; i++) {
      const bKey = deriveBroadcasterKey(masterKey, i);
      const bWallet = new ethers.Wallet(bKey, ethers.provider);
      const bal = await bWallet.getBalance();
      if (bal.lt(MIN_ETH)) {
        await (await deployer.sendTransaction({ to: bWallet.address, value: fundAmount })).wait();
        console.log(`  Broadcaster ${i}: ${bWallet.address} funded with 100 ETH`);
      } else {
        console.log(`  Broadcaster ${i}: ${bWallet.address} already funded (${ethers.utils.formatEther(bal)} ETH)`);
      }
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
  console.log(`\nCreating ${BENCH_USERS} wallets...`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < BENCH_USERS; i++) {
    const w = new Wallet(randomBytes(32), randomBytes(32));
    w.tokens.push(tokenData);
    wallets.push(w);
  }

  // Mint tokens if needed
  const totalNotes = BENCH_USERS * NOTES_PER_WALLET;
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
  console.log(`\nShielding ${NOTES_PER_WALLET} notes x ${BENCH_USERS} wallets = ${totalNotes} notes...`);
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

  for (let walletIdx = 0; walletIdx < BENCH_USERS; walletIdx++) {
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

  // Step 2: Encrypt + sign all batches using worker threads (multi-core)
  const workerCount = Math.min(os.cpus().length, allShieldBatches.length);
  console.log(`  Encrypting & signing (${workerCount} workers, ${totalNotes} notes)...`);

  // Derive user private key (same derivation as hardhat.config.ts)
  const userPrivateKey = '0x' + crypto.createHash('sha256').update(masterKey + '_user').digest('hex');

  // Serialize batches for IPC transfer (all values must be JSON-safe)
  const serializedBatches = allShieldBatches.map((batch) => ({
    walletIdx: batch.walletIdx,
    notes: batch.notes.map((n) => ({
      spendingKey: '0x' + Array.from(n.spendingKey).map((b) => b.toString(16).padStart(2, '0')).join(''),
      viewingKey: '0x' + Array.from(n.viewingKey).map((b) => b.toString(16).padStart(2, '0')).join(''),
      value: n.value.toString(),
      random: '0x' + Array.from(n.random).map((b) => b.toString(16).padStart(2, '0')).join(''),
      tokenType: n.tokenData.tokenType,
      tokenAddress: n.tokenData.tokenAddress,
      tokenSubID: n.tokenData.tokenSubID.toString(),
    })),
    nonceStart: batch.contractNonceStart.toHexString(),
  }));

  // Split batches into worker groups (round-robin for balanced load)
  const workerGroups: typeof serializedBatches[] = Array.from({ length: workerCount }, () => []);
  for (let i = 0; i < serializedBatches.length; i++) {
    workerGroups[i % workerCount].push(serializedBatches[i]);
  }

  // Track original batch order: workerGroups[wIdx][localIdx] came from serializedBatches[originalIdx]
  const batchOrder: { wIdx: number; localIdx: number }[] = [];
  const localCounters = new Array(workerCount).fill(0);
  for (let i = 0; i < serializedBatches.length; i++) {
    const wIdx = i % workerCount;
    batchOrder.push({ wIdx, localIdx: localCounters[wIdx] });
    localCounters[wIdx]++;
  }

  // Resolve worker path with ts-node support
  const workerPath = path.join(__dirname, 'bench-worker.ts');
  const tsNodeArgs = process.execArgv.some((a) => a.includes('ts-node'))
    ? process.execArgv
    : ['--require', 'ts-node/register/transpile-only', ...process.execArgv];

  // Spawn child processes
  const workerResults: any[][] = new Array(workerCount);
  const workerNotesDone: number[] = new Array(workerCount).fill(0);

  const workerPromises = workerGroups.map((group, wIdx) => {
    return new Promise<void>((resolve, reject) => {
      const child: ChildProcess = fork(workerPath, [], { execArgv: tsNodeArgs });

      child.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          // Child is ready, send the work
          child.send({
            type: 'init',
            data: {
              mode: 'shield',
              batches: group,
              domain,
              types: DELEGATE_SHIELD_TYPES,
              userPrivateKey,
              userAddress: user.address,
              deadline,
              workerId: wIdx,
            },
          });
        } else if (msg.type === 'progress') {
          workerNotesDone[wIdx] = msg.notesDone;
          const totalDone = workerNotesDone.reduce((a, b) => a + b, 0);
          if (totalDone % 500 < SHIELD_BATCH_SIZE || msg.notesDone === group.reduce((s: number, b: any) => s + b.notes.length, 0)) {
            console.log(`    Progress: ${totalDone}/${totalNotes} notes encrypted & signed`);
          }
        } else if (msg.type === 'done') {
          workerResults[wIdx] = msg.results;
          child.kill();
          resolve();
        } else if (msg.type === 'error') {
          child.kill();
          reject(new Error(`Worker ${wIdx}: ${msg.error}`));
        }
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0 && !workerResults[wIdx]) {
          reject(new Error(`Worker ${wIdx} exited with code ${code}`));
        }
      });
    });
  });

  await Promise.all(workerPromises);
  console.log('  All workers complete');

  // Reassemble results in original batch order (convert hex strings back to Uint8Array/BigInt)
  const preparedBatches = batchOrder.map(({ wIdx, localIdx }) => {
    const wr = workerResults[wIdx][localIdx];
    return {
      delegateShieldRequests: wr.delegateShieldRequests.map((d: any) => ({
        shieldRequest: {
          preimage: {
            npk: hexStringToArray(d.shieldRequest.preimage.npk),
            token: {
              tokenType: d.shieldRequest.preimage.token.tokenType,
              tokenAddress: d.shieldRequest.preimage.token.tokenAddress,
              tokenSubID: BigInt(d.shieldRequest.preimage.token.tokenSubID),
            },
            value: BigInt(d.shieldRequest.preimage.value),
          },
          ciphertext: {
            encryptedBundle: d.shieldRequest.ciphertext.encryptedBundle.map(
              (h: string) => hexStringToArray(h),
            ),
            shieldKey: hexStringToArray(d.shieldRequest.ciphertext.shieldKey),
          },
        },
        from: d.from,
        nonce: ethers.BigNumber.from(d.nonce),
        deadline: d.deadline,
      })),
      signatures: wr.signatures,
      walletIdx: wr.walletIdx,
    };
  });
  console.log('  All batches encrypted & signed');

  // Step 3+4: Submit delegateShield calls in chunks to avoid txpool overflow
  const SHIELD_GAS_LIMIT = 15_000_000;
  const SHIELD_SUBMIT_CHUNK = 200; // max txs to submit before waiting for confirmations
  console.log(`  Submitting ${preparedBatches.length} shield txs (chunk size: ${SHIELD_SUBMIT_CHUNK})...`);

  // Wait until no pending transactions remain for broadcaster (avoid nonce conflicts from previous runs)
  {
    let pendingCount = await broadcaster.getTransactionCount('pending');
    let latestCount = await broadcaster.getTransactionCount('latest');
    if (pendingCount !== latestCount) {
      console.log(`  Waiting for ${pendingCount - latestCount} pending broadcaster txs to clear...`);
      while (pendingCount !== latestCount) {
        await new Promise((r) => setTimeout(r, 2000));
        pendingCount = await broadcaster.getTransactionCount('pending');
        latestCount = await broadcaster.getTransactionCount('latest');
      }
      console.log('  Pending txs cleared');
    }
  }

  const allShieldTxResponses: any[] = [];
  let shieldNonce = await broadcaster.getTransactionCount('latest');

  // Use explicit gasPrice to avoid replacement-fee issues on chains with EIP-1559
  const currentGasPrice = await ethers.provider.getGasPrice();
  const shieldGasPrice = currentGasPrice.mul(2); // 2x to ensure replacement

  for (let chunkStart = 0; chunkStart < preparedBatches.length; chunkStart += SHIELD_SUBMIT_CHUNK) {
    const chunkEnd = Math.min(chunkStart + SHIELD_SUBMIT_CHUNK, preparedBatches.length);
    const chunk = preparedBatches.slice(chunkStart, chunkEnd);

    // Fire chunk with manually tracked nonces
    const chunkBaseNonce = shieldNonce;
    const txResponses = await Promise.all(
      chunk.map(async (p, i) => {
        return relayAdapt.connect(broadcaster).delegateShield(
          p.delegateShieldRequests,
          p.signatures,
          { nonce: chunkBaseNonce + i, gasLimit: SHIELD_GAS_LIMIT, gasPrice: shieldGasPrice },
        );
      }),
    );
    shieldNonce += chunk.length;

    // Wait for confirmations
    const receipts = await Promise.all(txResponses.map((tx) => tx.wait()));
    for (const receipt of receipts) {
      totalShieldGas = totalShieldGas.add(receipt.gasUsed);
    }

    allShieldTxResponses.push(...txResponses);
    console.log(`    Confirmed ${chunkEnd}/${preparedBatches.length} shield txs`);
  }

  // Step 5: Optimized batch scan (bulk insert leaves + rebuild tree once)
  //   Old approach: scanTX per tx => rebuildSparseTree 1000x
  //   New approach: collect all leaves, insert once, rebuild once => ~1000x faster for tree
  console.log('  Scanning shield events...');
  const scanStart = Date.now();

  // 5a: Fetch all receipts in parallel (already confirmed, so instant)
  const allReceipts = await Promise.all(allShieldTxResponses.map((tx) => tx.wait()));

  // 5b: Parse all Shield events, compute Poseidon hashes, bulk-insert into tree[0]
  for (let i = 0; i < allReceipts.length; i++) {
    const receipt = allReceipts[i];
    for (const log of receipt.logs) {
      if (log.address !== railgun.address) continue;
      const parsedLog = railgun.interface.parseLog(log);
      if (parsedLog.name !== 'Shield') continue;
      const args = parsedLog.args as any;
      const startPosition = args.startPosition.toNumber();

      // Compute Poseidon leaf hash for each commitment
      const leaves = await Promise.all(
        args.commitments.map((commitment: any) =>
          cryptoHash.poseidon([
            hexStringToArray(commitment.npk),
            getTokenID({
              tokenType: commitment.token.tokenType,
              tokenAddress: commitment.token.tokenAddress,
              tokenSubID: commitment.token.tokenSubID.toBigInt(),
            }),
            bigIntToArray(commitment.value.toBigInt(), 32),
          ]),
        ),
      );

      // Direct insert into leaf level (skip rebuildSparseTree)
      leaves.forEach((leaf: Uint8Array, idx: number) => {
        merkletree.tree[0][startPosition + idx] = leaf;
      });
    }
  }

  // 5c: Rebuild entire tree ONCE (instead of 1000x)
  await merkletree.rebuildSparseTree();
  console.log(`  Tree rebuilt in ${Date.now() - scanStart}ms`);

  // 5d: Scan wallets in parallel (each wallet is independent, no shared state)
  const walletScanStart = Date.now();
  await Promise.all(
    wallets.map(async (wallet, wIdx) => {
      for (let i = 0; i < allReceipts.length; i++) {
        if (allShieldBatches[i].walletIdx !== wIdx) continue;
        const receipt = allReceipts[i];
        for (const log of receipt.logs) {
          if (log.address !== railgun.address) continue;
          const parsedLog = railgun.interface.parseLog(log);
          if (parsedLog.name !== 'Shield') continue;
          const args = parsedLog.args as any;
          const startPosition = args.startPosition.toNumber();

          args.shieldCiphertext.map((shieldCiphertext: any, index: number) => {
            const decrypted = Note.decryptShield(
              hexStringToArray(shieldCiphertext.shieldKey),
              shieldCiphertext.encryptedBundle.map(hexStringToArray) as [
                Uint8Array,
                Uint8Array,
                Uint8Array,
              ],
              {
                tokenType: args.commitments[index].token.tokenType,
                tokenAddress: args.commitments[index].token.tokenAddress,
                tokenSubID: args.commitments[index].token.tokenSubID.toBigInt(),
              },
              args.commitments[index].value.toBigInt(),
              wallet.viewingKey,
              wallet.spendingKey,
            );
            if (decrypted) {
              wallet.notes[startPosition + index] = decrypted;
            }
          });
        }
      }
    }),
  );
  console.log(`  Wallets scanned in ${Date.now() - walletScanStart}ms`);

  for (let i = 0; i < BENCH_USERS; i++) {
    if (i % 100 === 0 || i === BENCH_USERS - 1) {
      console.log(`  Wallet ${i}: ${wallets[i].notes.filter(Boolean).length} notes shielded`);
    }
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
    if (i % 100 === 0 || i === wallets.length - 1) {
      console.log(`  Wallet ${i}: ${unspent.length} unspent notes`);
    }
  }

  // Generate transfer pairs
  const pairs = generateTransferPairs(
    wallets.length,
    BENCH_TOTAL_UOP,
    unspentNotesPerWallet.map((n) => n.length),
  );
  const actualTxCount = pairs.length;
  console.log(`\nTransfer pairs: ${actualTxCount} (round-robin)`);

  if (actualTxCount === 0) {
    throw new Error('No transactions to benchmark! Not enough notes.');
  }

  // Group into relay batches
  const relayBatches: TransferPair[][] = [];
  for (let i = 0; i < actualTxCount; i += BENCH_BATCH_COUNT) {
    relayBatches.push(pairs.slice(i, i + BENCH_BATCH_COUNT));
  }
  console.log(`Relay batches: ${relayBatches.length} (${BENCH_BATCH_COUNT} UOp/batch)`);

  // Prepare inputs/outputs for all batches
  interface BatchData {
    inputNotesList: Note[][];
    outputNotesList: Note[][];
    adaptParams: Uint8Array;
    actionData: any;
  }

  console.log('\nPreparing batch data (adaptParams)...');
  const batchPrepStart = Date.now();

  // Step A: Pre-compute all unique note hashes & nullifiers using multi-process workers
  //   Each Poseidon hash is CPU-bound; distribute across all CPU cores for ~Nx speedup

  // A1: Collect unique notes and assign IDs
  const uniqueNotes: Note[] = [];
  const noteToId = new Map<Note, number>();
  for (const pair of pairs) {
    const senderUnspent = unspentNotesPerWallet[pair.senderIdx];
    for (const noteIdx of pair.inputNoteIndices) {
      const note = senderUnspent[noteIdx];
      if (!noteToId.has(note)) {
        noteToId.set(note, uniqueNotes.length);
        uniqueNotes.push(note);
      }
    }
  }
  console.log(`  ${uniqueNotes.length} unique notes to hash`);

  // A2: Build hashToIndex lookup from tree[0] (leaf level)
  const hashToIndex: Record<string, number> = {};
  for (let i = 0; i < merkletree.tree[0].length; i++) {
    if (merkletree.tree[0][i]) {
      hashToIndex[arrayToHexString(merkletree.tree[0][i], true)] = i;
    }
  }

  // A3: Serialize note tasks for IPC
  const noteTasks = uniqueNotes.map((note, id) => ({
    id,
    spendingKey: arrayToHexString(note.spendingKey, true),
    viewingKey: arrayToHexString(note.viewingKey, true),
    value: note.value.toString(),
    random: arrayToHexString(note.random, true),
    tokenType: note.tokenData.tokenType,
    tokenAddress: note.tokenData.tokenAddress,
    tokenSubID: note.tokenData.tokenSubID.toString(),
  }));

  // A4: Fork workers and distribute tasks
  const nullWorkerCount = Math.min(os.cpus().length, uniqueNotes.length);
  console.log(`  Hashing with ${nullWorkerCount} workers...`);

  const nullWorkerPath = path.join(__dirname, 'bench-worker.ts');
  const chunkSize = Math.ceil(noteTasks.length / nullWorkerCount);
  const nullWorkerDone: number[] = new Array(nullWorkerCount).fill(0);

  const nullWorkerResults: { id: number; hash: string; nullifier: string }[][] = new Array(nullWorkerCount);

  const nullWorkerPromises = Array.from({ length: nullWorkerCount }, (_, wIdx) => {
    const myTasks = noteTasks.slice(wIdx * chunkSize, (wIdx + 1) * chunkSize);
    if (myTasks.length === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const child: ChildProcess = fork(nullWorkerPath, [], { execArgv: tsNodeArgs });

      child.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          child.send({
            type: 'init',
            data: { mode: 'nullifier', tasks: myTasks, hashToIndex, workerId: wIdx },
          });
        } else if (msg.type === 'progress') {
          nullWorkerDone[wIdx] = msg.done;
          const totalDone = nullWorkerDone.reduce((a, b) => a + b, 0);
          if (totalDone % 2000 < 500 || msg.done === myTasks.length) {
            console.log(`    Progress: ${totalDone}/${uniqueNotes.length} note hashes computed`);
          }
        } else if (msg.type === 'done') {
          nullWorkerResults[wIdx] = msg.results;
          child.kill();
          resolve();
        } else if (msg.type === 'error') {
          child.kill();
          reject(new Error(`Nullifier worker ${wIdx}: ${msg.error}`));
        }
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0 && !nullWorkerResults[wIdx]) {
          reject(new Error(`Nullifier worker ${wIdx} exited with code ${code}`));
        }
      });
    });
  });

  await Promise.all(nullWorkerPromises);
  console.log(`  All nullifier workers complete`);

  // A5: Populate caches from worker results
  const noteHashCache = new Map<Note, Uint8Array>();
  const noteNullifierCache = new Map<Note, string>();
  for (const workerResult of nullWorkerResults) {
    if (!workerResult) continue;
    for (const r of workerResult) {
      const note = uniqueNotes[r.id];
      noteHashCache.set(note, hexStringToArray(r.hash));
      noteNullifierCache.set(note, r.nullifier);
    }
  }
  console.log(`  ${noteHashCache.size} hashes + nullifiers cached in ${Date.now() - batchPrepStart}ms`);

  // Step B: Assemble batches using cached values (pure data, no async crypto)
  const batchDataList: BatchData[] = [];
  for (let bIdx = 0; bIdx < relayBatches.length; bIdx++) {
    const batch = relayBatches[bIdx];
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

    // Build adaptParams from cached nullifiers (no async Poseidon needed)
    const nullifiers2D: string[][] = [];
    for (const inputNotes of inputNotesList) {
      const txNullifiers: string[] = [];
      for (const note of inputNotes) {
        txNullifiers.push(noteNullifierCache.get(note)!);
      }
      nullifiers2D.push(txNullifiers);
    }

    const actionData = {
      random: ethers.utils.hexlify(randomBytes(31)),
      requireSuccess: true,
      minGasLimit: 0,
      calls: [] as { to: string; data: string; value: any }[],
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      [
        'bytes32[][]',
        'uint256',
        'tuple(bytes31 random, bool requireSuccess, uint256 minGasLimit, tuple(address to, bytes data, uint256 value)[] calls)',
      ],
      [nullifiers2D, inputNotesList.length, actionData],
    );
    const adaptParams = new Uint8Array(ethers.utils.arrayify(ethers.utils.keccak256(encoded)));

    batchDataList.push({ inputNotesList, outputNotesList, adaptParams, actionData });

    if ((bIdx + 1) % 200 === 0 || bIdx === relayBatches.length - 1) {
      console.log(`  Assembled ${bIdx + 1}/${relayBatches.length} batches`);
    }
  }
  console.log(`  ${batchDataList.length} batches prepared in ${Date.now() - batchPrepStart}ms`);

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

  // ---- Multi-process full transact (encrypt + circuit inputs + witness + proof + format) ----
  const PROOF_WORKERS = Math.min(os.cpus().length, allProofTasks.length);
  const proofPhaseStart = Date.now();
  console.log(`\nGenerating ${allProofTasks.length} proofs (${PROOF_WORKERS} workers, full pipeline)...`);

  // Cache artifact files to disk for workers
  const artifact = getKeys(INPUTS_PER_TX, OUTPUTS_PER_TX);
  const artifactCacheDir = path.join(os.tmpdir(), 'rapidsnark-artifacts');
  if (!fs.existsSync(artifactCacheDir)) fs.mkdirSync(artifactCacheDir, { recursive: true });
  const artCacheKey = `${artifact.wasm.length}_${artifact.zkey.length}`;
  const artWasmPath = path.join(artifactCacheDir, `${artCacheKey}.wasm`);
  const artZkeyPath = path.join(artifactCacheDir, `${artCacheKey}.zkey`);
  if (!fs.existsSync(artWasmPath)) fs.writeFileSync(artWasmPath, artifact.wasm);
  if (!fs.existsSync(artZkeyPath)) fs.writeFileSync(artZkeyPath, artifact.zkey);

  // Serialize MerkleTree for workers (sent once per worker)
  function serializeMerkleTree(mt: MerkleTree) {
    return {
      treeNumber: mt.treeNumber,
      depth: mt.depth,
      zeros: mt.zeros.map((z: Uint8Array) => toHex(z)),
      tree: mt.tree.map((level: Uint8Array[]) => {
        const arr: (string | null)[] = new Array(level.length);
        for (let i = 0; i < level.length; i++) {
          arr[i] = level[i] ? toHex(level[i]) : null;
        }
        return arr;
      }),
    };
  }
  const serializedTree = serializeMerkleTree(merkletree);

  // Serialize Note for IPC
  function serializeNote(note: Note) {
    return {
      spendingKey: toHex(note.spendingKey),
      viewingKey: toHex(note.viewingKey),
      value: note.value.toString(),
      random: toHex(note.random),
      tokenType: note.tokenData.tokenType,
      tokenAddress: note.tokenData.tokenAddress,
      tokenSubID: note.tokenData.tokenSubID.toString(),
    };
  }

  // Build serialized task list
  const serializedTasks = allProofTasks.map((task, i) => ({
    taskId: i,
    inputNotes: task.inputNotes.map(serializeNote),
    outputNotes: task.outputNotes.map(serializeNote),
    adaptParams: toHex(task.adaptParams),
  }));

  // Distribute tasks evenly to workers
  const proofChunkSize = Math.ceil(allProofTasks.length / PROOF_WORKERS);
  const proofWorkerDone: number[] = new Array(PROOF_WORKERS).fill(0);
  const proofWorkerResults: { taskId: number; serializedPI: any; nullifiers: string[] }[][] = new Array(PROOF_WORKERS);
  const proofWorkerPath = path.join(__dirname, 'bench-worker.ts');

  const proofWorkerPromises = Array.from({ length: PROOF_WORKERS }, (_, wIdx) => {
    const startIdx = wIdx * proofChunkSize;
    const endIdx = Math.min(startIdx + proofChunkSize, allProofTasks.length);
    const myTasks = serializedTasks.slice(startIdx, endIdx);
    if (myTasks.length === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const child: ChildProcess = fork(proofWorkerPath, [], { execArgv: tsNodeArgs });

      child.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          child.send({
            type: 'init',
            data: {
              mode: 'transact',
              tasks: myTasks,
              merkletree: serializedTree,
              rootIndex,
              chainID: chainID.toString(),
              adaptContract: relayAdapt.address,
              wasmPath: artWasmPath,
              zkeyPath: artZkeyPath,
              workerId: wIdx,
            },
          });
        } else if (msg.type === 'progress') {
          proofWorkerDone[wIdx] = msg.done;
          const totalDone = proofWorkerDone.reduce((a, b) => a + b, 0);
          if (totalDone % 50 === 0 || msg.done === myTasks.length) {
            console.log(`  ${totalDone}/${allProofTasks.length} proofs done`);
          }
        } else if (msg.type === 'done') {
          proofWorkerResults[wIdx] = msg.results;
          child.kill();
          resolve();
        } else if (msg.type === 'error') {
          child.kill();
          reject(new Error(`Proof worker ${wIdx}: ${msg.error}`));
        }
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0 && !proofWorkerResults[wIdx]) {
          reject(new Error(`Proof worker ${wIdx} exited with code ${code}`));
        }
      });
    });
  });

  await Promise.all(proofWorkerPromises);
  const proofPhaseTotal = Date.now() - proofPhaseStart;
  console.log(`\nProof phase complete: ${proofPhaseTotal}ms (${PROOF_WORKERS} workers)`);

  // Collect results: workers return serialized PublicInputs directly
  // Build allBatchTransactions (serialized form) and allNullifiers
  const allBatchSerializedTxs: any[][] = batchDataList.map(() => []);
  const allNullifiers: string[] = [];

  for (const workerResult of proofWorkerResults) {
    if (!workerResult) continue;
    for (const r of workerResult) {
      const task = allProofTasks[r.taskId];
      allBatchSerializedTxs[task.batchIdx][task.txIdx] = r.serializedPI;
      allNullifiers.push(...r.nullifiers);
    }
  }

  // ========================================================
  // Save to bench-proofs.json
  // ========================================================
  console.log('\n--- Saving proofs to bench-proofs.json ---\n');

  const benchProofs = {
    config: {
      users: BENCH_USERS,
      totalUop: actualTxCount,
      batchCount: BENCH_BATCH_COUNT,
      broadcasterCount: BENCH_BROADCASTER_COUNT,
      inputsPerTx: INPUTS_PER_TX,
      outputsPerTx: OUTPUTS_PER_TX,
    },
    rootIndex,
    root: rootHex,
    nullifiers: allNullifiers,
    batches: allBatchSerializedTxs.map((batchTxs, batchIdx) => ({
      transactions: batchTxs,
      actionData: batchDataList[batchIdx].actionData,
    })),
    proofStats: {
      totalMs: proofPhaseTotal,
      workers: PROOF_WORKERS,
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
  console.log(`  ${allBatchSerializedTxs.length} batches, ${actualTxCount} transactions`);
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
