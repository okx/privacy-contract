/**
 * Unified Bench Worker - handles 3 modes via IPC:
 *
 *   mode: 'shield'     - encryptForShield + EIP-712 signing
 *   mode: 'nullifier'  - compute note hashes + nullifiers
 *   mode: 'prove'      - witness generation + SNARK proof (rapidsnark/snarkjs)
 *
 * Spawned by bench-setup.ts using child_process.fork().
 * Message protocol: parent sends { type: 'init', data: { mode, ...payload } }
 *                   worker sends { type: 'ready' | 'progress' | 'done' | 'error' }
 */

// === Imports for shield + nullifier modes ===
import { ethers } from 'ethers';
import { Note, TokenType, TokenData } from '../helpers/logic/note';

// === Imports for prove mode ===
import { groth16, wtns } from 'snarkjs';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// === Config ===
const USE_RAPIDSNARK = process.env.USE_RAPIDSNARK === 'true';
const RAPIDSNARK_PATH = process.env.RAPIDSNARK_PATH || '/usr/local/bin/rapidsnark';

// ============ Shared Helpers ============

function hexToUint8(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function uint8ToHex(arr: Uint8Array): string {
  return '0x' + Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeNote(nd: SerializedNote): Note {
  return new Note(
    hexToUint8(nd.spendingKey),
    hexToUint8(nd.viewingKey),
    BigInt(nd.value),
    hexToUint8(nd.random),
    { tokenType: nd.tokenType as TokenType, tokenAddress: nd.tokenAddress, tokenSubID: BigInt(nd.tokenSubID) },
    '',
  );
}

// ============ Shared types ============

interface SerializedNote {
  spendingKey: string;  // hex
  viewingKey: string;   // hex
  value: string;        // bigint as decimal string
  random: string;       // hex
  tokenType: number;
  tokenAddress: string;
  tokenSubID: string;   // bigint as decimal string
}

// ============================================================
// MODE: shield - encryptForShield + EIP-712 signing
// ============================================================

interface ShieldBatch {
  walletIdx: number;
  notes: SerializedNote[];
  nonceStart: string;
}

async function runShield(data: {
  batches: ShieldBatch[];
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: any;
  userPrivateKey: string;
  userAddress: string;
  deadline: number;
  workerId: number;
}) {
  const signer = new ethers.Wallet(data.userPrivateKey);
  const allResults: any[] = [];
  let notesDone = 0;

  for (const batch of data.batches) {
    const nonceStart = ethers.BigNumber.from(batch.nonceStart);
    const delegateShieldRequests: any[] = [];
    const signatures: string[] = [];

    for (let i = 0; i < batch.notes.length; i++) {
      const note = makeNote(batch.notes[i]);
      const shieldReq = await note.encryptForShield();
      const nonce = nonceStart.add(i);

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
        from: data.userAddress,
        nonce,
        deadline: data.deadline,
      };

      const sig = await signer._signTypedData(data.domain, data.types, message);

      delegateShieldRequests.push({
        shieldRequest: {
          preimage: {
            npk: uint8ToHex(shieldReq.preimage.npk),
            token: {
              tokenType: shieldReq.preimage.token.tokenType,
              tokenAddress: shieldReq.preimage.token.tokenAddress,
              tokenSubID: shieldReq.preimage.token.tokenSubID.toString(),
            },
            value: shieldReq.preimage.value.toString(),
          },
          ciphertext: {
            encryptedBundle: [
              uint8ToHex(shieldReq.ciphertext.encryptedBundle[0]),
              uint8ToHex(shieldReq.ciphertext.encryptedBundle[1]),
              uint8ToHex(shieldReq.ciphertext.encryptedBundle[2]),
            ],
            shieldKey: uint8ToHex(shieldReq.ciphertext.shieldKey),
          },
        },
        from: data.userAddress,
        nonce: nonce.toHexString(),
        deadline: data.deadline,
      });
      signatures.push(sig);
      notesDone++;
    }

    allResults.push({ delegateShieldRequests, signatures, walletIdx: batch.walletIdx });
    process.send!({ type: 'progress', notesDone, workerId: data.workerId });
  }

  process.send!({ type: 'done', results: allResults, workerId: data.workerId });
}

// ============================================================
// MODE: nullifier - compute note hashes + nullifiers
// ============================================================

interface NullifierTask {
  id: number;
  spendingKey: string;
  viewingKey: string;
  value: string;
  random: string;
  tokenType: number;
  tokenAddress: string;
  tokenSubID: string;
}

async function runNullifier(data: {
  tasks: NullifierTask[];
  hashToIndex: Record<string, number>;
  workerId: number;
}) {
  const results: { id: number; hash: string; nullifier: string }[] = [];
  let done = 0;

  for (const task of data.tasks) {
    const note = makeNote(task);
    const noteHash = await note.getHash();
    const hashHex = uint8ToHex(noteHash);
    const leafIndex = data.hashToIndex[hashHex];

    if (leafIndex === undefined) {
      throw new Error(`Note hash not found in tree: ${hashHex}`);
    }

    const nullifier = await note.getNullifier(leafIndex);
    results.push({ id: task.id, hash: hashHex, nullifier: uint8ToHex(nullifier) });

    done++;
    if (done % 500 === 0 || done === data.tasks.length) {
      process.send!({ type: 'progress', done, total: data.tasks.length, workerId: data.workerId });
    }
  }

  process.send!({ type: 'done', results, workerId: data.workerId });
}

// ============================================================
// MODE: prove - witness generation + SNARK proof
// ============================================================

interface ProveTask {
  taskId: number;
  circuitInputs: Record<string, any>;  // bigints already serialized as strings
}

async function runProve(data: {
  tasks: ProveTask[];
  wasmPath: string;
  zkeyPath: string;
  workerId: number;
}) {
  const results: { taskId: number; proof: any }[] = [];
  let done = 0;

  for (const task of data.tasks) {
    if (USE_RAPIDSNARK) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-worker-'));
      try {
        const witnessPath = path.join(tmpDir, 'witness.wtns');
        const proofPath = path.join(tmpDir, 'proof.json');
        const publicPath = path.join(tmpDir, 'public.json');

        // Step 1: witness (snarkjs WASM)
        await wtns.calculate(task.circuitInputs, data.wasmPath, witnessPath);

        // Step 2: proof (rapidsnark C++)
        execSync(
          `"${RAPIDSNARK_PATH}" "${data.zkeyPath}" "${witnessPath}" "${proofPath}" "${publicPath}"`,
          { stdio: 'pipe' },
        );

        const proofJson = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));
        results.push({ taskId: task.taskId, proof: proofJson });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Pure snarkjs
      const { proof } = await groth16.fullProve(task.circuitInputs, data.wasmPath as any, data.zkeyPath as any);
      results.push({ taskId: task.taskId, proof });
    }

    done++;
    if (done % 5 === 0 || done === data.tasks.length) {
      process.send!({ type: 'progress', done, total: data.tasks.length, workerId: data.workerId });
    }
  }

  process.send!({ type: 'done', results, workerId: data.workerId });
}

// ============================================================
// MODE: transact - full pipeline (encrypt + formatCircuitInputs + prove + formatPublicInputs)
//   Runs the entire transact pipeline in the worker, using a hardhat shim
//   so that transaction.ts can import { ethers } from 'hardhat'.
// ============================================================

/**
 * Register a shim for 'hardhat' module that provides standalone ethers.
 * This allows importing transaction.ts (which does `import { ethers } from 'hardhat'`)
 * in a child process without the full hardhat runtime.
 * Only ethers.utils and ethers.constants are used by transaction.ts.
 */
function setupHardhatShim() {
  const ethersStandalone = require('ethers');
  try {
    const hardhatPath = require.resolve('hardhat');
    require.cache[hardhatPath] = {
      id: hardhatPath,
      filename: hardhatPath,
      loaded: true,
      exports: { ethers: ethersStandalone },
      children: [],
      paths: [],
      parent: null,
    } as any;
  } catch {
    // hardhat not installed - skip
  }
}

interface TransactTask {
  taskId: number;
  inputNotes: SerializedNote[];
  outputNotes: SerializedNote[];
  adaptParams: string;  // hex
}

interface SerializedMerkleTree {
  treeNumber: number;
  depth: number;
  zeros: string[];        // hex[]
  tree: (string | null)[][]; // hex or null per node
}

function deserializeMerkleTree(data: SerializedMerkleTree, MerkleTreeClass: any): any {
  const zeros = data.zeros.map((z: string) => hexToUint8(z));
  const tree: (Uint8Array | undefined)[][] = data.tree.map(
    (level: (string | null)[]) => {
      const arr: (Uint8Array | undefined)[] = new Array(level.length);
      for (let i = 0; i < level.length; i++) {
        arr[i] = level[i] ? hexToUint8(level[i]!) : undefined;
      }
      return arr;
    },
  );
  return new MerkleTreeClass(data.treeNumber, data.depth, zeros, tree);
}

function serializePublicInputsForIPC(pi: any): any {
  const toHex = (arr: Uint8Array) => uint8ToHex(arr);
  const bigStr = (n: bigint) => n.toString();
  return {
    proof: {
      a: { x: bigStr(pi.proof.a.x), y: bigStr(pi.proof.a.y) },
      b: {
        x: [bigStr(pi.proof.b.x[0]), bigStr(pi.proof.b.x[1])],
        y: [bigStr(pi.proof.b.y[0]), bigStr(pi.proof.b.y[1])],
      },
      c: { x: bigStr(pi.proof.c.x), y: bigStr(pi.proof.c.y) },
    },
    merkleRoot: toHex(pi.merkleRoot),
    rootIndex: pi.rootIndex,
    nullifiers: pi.nullifiers.map(toHex),
    commitments: pi.commitments.map(toHex),
    boundParams: {
      minGasPrice: bigStr(pi.boundParams.minGasPrice),
      unshield: pi.boundParams.unshield,
      chainID: bigStr(pi.boundParams.chainID),
      adaptContract: pi.boundParams.adaptContract,
      adaptParams: toHex(pi.boundParams.adaptParams),
      commitmentCiphertext: pi.boundParams.commitmentCiphertext.map((cc: any) => ({
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
        tokenSubID: bigStr(pi.unshieldPreimage.token.tokenSubID),
      },
      value: bigStr(pi.unshieldPreimage.value),
    },
  };
}

async function runTransact(data: {
  tasks: TransactTask[];
  merkletree: SerializedMerkleTree;
  rootIndex: number;
  chainID: string;        // bigint as string
  adaptContract: string;  // address
  wasmPath: string;
  zkeyPath: string;
  workerId: number;
}) {
  // Shim hardhat before loading transaction.ts
  setupHardhatShim();

  // Dynamic require: transaction.ts imports from 'hardhat' (now shimmed)
  const { formatCircuitInputs, formatPublicInputs, UnshieldType } = require('../helpers/logic/transaction');
  const { MerkleTree } = require('../helpers/logic/merkletree');

  // Reconstruct MerkleTree
  const merkletree = deserializeMerkleTree(data.merkletree, MerkleTree);
  const chainID = BigInt(data.chainID);

  const results: { taskId: number; serializedPI: any; nullifiers: string[] }[] = [];
  let done = 0;

  for (const task of data.tasks) {
    const inputNotes = task.inputNotes.map(makeNote);
    const outputNotes = task.outputNotes.map(makeNote);
    const adaptParams = hexToUint8(task.adaptParams);

    // Step 1: Encrypt output notes
    const senderViewingKey = inputNotes[0].viewingKey;
    const commitmentCiphertext = await Promise.all(
      outputNotes.map((note: any) => note.encrypt(senderViewingKey, false)),
    );

    // Step 2: Format circuit inputs
    const circuitInputs = await formatCircuitInputs(
      merkletree, 0n, UnshieldType.NONE, chainID,
      data.adaptContract, adaptParams,
      inputNotes, outputNotes, commitmentCiphertext,
    );

    // Step 3: Witness + Proof (reuse prove logic)
    let proofBundle: any;
    if (USE_RAPIDSNARK) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transact-worker-'));
      try {
        const witnessPath = path.join(tmpDir, 'witness.wtns');
        const proofPath = path.join(tmpDir, 'proof.json');
        const publicPath = path.join(tmpDir, 'public.json');
        await wtns.calculate(circuitInputs, data.wasmPath, witnessPath);
        execSync(
          `"${RAPIDSNARK_PATH}" "${data.zkeyPath}" "${witnessPath}" "${proofPath}" "${publicPath}"`,
          { stdio: 'pipe' },
        );
        const pj = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));
        proofBundle = {
          javascript: { pi_a: pj.pi_a, pi_b: pj.pi_b, pi_c: pj.pi_c, protocol: pj.protocol || 'groth16', curve: pj.curve || 'bn128' },
          solidity: {
            a: { x: BigInt(pj.pi_a[0]), y: BigInt(pj.pi_a[1]) },
            b: { x: [BigInt(pj.pi_b[0][1]), BigInt(pj.pi_b[0][0])], y: [BigInt(pj.pi_b[1][1]), BigInt(pj.pi_b[1][0])] },
            c: { x: BigInt(pj.pi_c[0]), y: BigInt(pj.pi_c[1]) },
          },
        };
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      const { proof } = await groth16.fullProve(circuitInputs, data.wasmPath as any, data.zkeyPath as any);
      proofBundle = {
        javascript: proof,
        solidity: {
          a: { x: BigInt(proof.pi_a[0]), y: BigInt(proof.pi_a[1]) },
          b: { x: [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], y: [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] },
          c: { x: BigInt(proof.pi_c[0]), y: BigInt(proof.pi_c[1]) },
        },
      };
    }

    // Step 4: Format public inputs
    const publicInputs = await formatPublicInputs(
      proofBundle, merkletree, data.rootIndex, 0n, UnshieldType.NONE, chainID,
      data.adaptContract, adaptParams,
      inputNotes, outputNotes, commitmentCiphertext,
    );

    // Serialize for IPC
    const serializedPI = serializePublicInputsForIPC(publicInputs);
    const nullifiers = publicInputs.nullifiers.map((n: Uint8Array) => uint8ToHex(n));
    results.push({ taskId: task.taskId, serializedPI, nullifiers });

    done++;
    if (done % 5 === 0 || done === data.tasks.length) {
      process.send!({ type: 'progress', done, total: data.tasks.length, workerId: data.workerId });
    }
  }

  process.send!({ type: 'done', results, workerId: data.workerId });
}

// ============================================================
// Dispatcher
// ============================================================

process.on('message', (msg: any) => {
  if (msg.type === 'init') {
    const { mode } = msg.data;
    let runner: Promise<void>;

    if (mode === 'shield') runner = runShield(msg.data);
    else if (mode === 'nullifier') runner = runNullifier(msg.data);
    else if (mode === 'prove') runner = runProve(msg.data);
    else if (mode === 'transact') runner = runTransact(msg.data);
    else {
      process.send!({ type: 'error', error: `Unknown mode: ${mode}` });
      return;
    }

    runner.catch((err) => {
      process.send!({ type: 'error', error: err.message, workerId: msg.data.workerId });
      process.exit(1);
    });
  }
});

// Signal ready
process.send!({ type: 'ready' });
