/**
 * Bench Submit: Load pre-generated proofs, reset chain state, submit relay batches, measure TPS.
 *
 * Supports multi-broadcaster mode: multiple instances run in parallel, each with its own
 * broadcaster wallet, coordinated via barrier files (like SA-Benchmark).
 *
 * Environment variables:
 *   BENCH_BROADCASTER_INDEX  - This process's index (0..N-1), default 0
 *   BENCH_BROADCASTER_COUNT  - Total broadcaster processes, default 1
 *   BENCH_RATE_LIMIT         - Global UOps/s limit (0=unlimited), default 0
 *   BARRIER_DIR              - Directory for barrier sync files
 *   PRIVATE_KEY              - Master private key for wallet derivation
 *
 * Usage:
 *   npx hardhat run scripts/bench-submit.ts --network localhost
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { hexStringToArray } from '../helpers/global/bytes';
import { PublicInputs } from '../helpers/logic/transaction';

// ============ Configuration ============
const BROADCASTER_INDEX = parseInt(process.env.BENCH_BROADCASTER_INDEX || '0', 10);
const BROADCASTER_COUNT = parseInt(process.env.BENCH_BROADCASTER_COUNT || '1', 10);
const RATE_LIMIT = parseInt(process.env.BENCH_RATE_LIMIT || '0', 10);
const BARRIER_DIR = process.env.BARRIER_DIR || '';
const LOG_PREFIX = BROADCASTER_COUNT > 1 ? `[D${BROADCASTER_INDEX}] ` : '';

// ============ Internal constants ============
const GAS_LIMIT_PER_RELAY = 30000000;

// ============ Helpers ============

function deriveBroadcasterKey(masterKey: string, index: number): string {
  return '0x' + crypto.createHash('sha256')
    .update(masterKey + '_bench_broadcaster_' + index)
    .digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============ Deserialization helpers ============

function fromHex(hex: string): Uint8Array {
  return hexStringToArray(hex);
}

function deserializePublicInputs(s: any): PublicInputs {
  return {
    proof: {
      a: { x: BigInt(s.proof.a.x), y: BigInt(s.proof.a.y) },
      b: {
        x: [BigInt(s.proof.b.x[0]), BigInt(s.proof.b.x[1])],
        y: [BigInt(s.proof.b.y[0]), BigInt(s.proof.b.y[1])],
      },
      c: { x: BigInt(s.proof.c.x), y: BigInt(s.proof.c.y) },
    },
    merkleRoot: fromHex(s.merkleRoot),
    rootIndex: s.rootIndex,
    nullifiers: s.nullifiers.map(fromHex),
    commitments: s.commitments.map(fromHex),
    boundParams: {
      minGasPrice: BigInt(s.boundParams.minGasPrice),
      unshield: s.boundParams.unshield,
      chainID: BigInt(s.boundParams.chainID),
      adaptContract: s.boundParams.adaptContract,
      adaptParams: fromHex(s.boundParams.adaptParams),
      commitmentCiphertext: s.boundParams.commitmentCiphertext.map((cc: any) => ({
        ciphertext: cc.ciphertext.map(fromHex) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
        blindedSenderViewingKey: fromHex(cc.blindedSenderViewingKey),
        blindedReceiverViewingKey: fromHex(cc.blindedReceiverViewingKey),
        annotationData: fromHex(cc.annotationData),
        memo: fromHex(cc.memo),
      })),
    },
    unshieldPreimage: {
      npk: fromHex(s.unshieldPreimage.npk),
      token: {
        tokenType: s.unshieldPreimage.token.tokenType,
        tokenAddress: s.unshieldPreimage.token.tokenAddress,
        tokenSubID: BigInt(s.unshieldPreimage.token.tokenSubID),
      },
      value: BigInt(s.unshieldPreimage.value),
    },
  };
}

// ============ Main ============

async function main() {
  // ========== Load proofs ==========
  const proofsPath = path.join(__dirname, '../bench-proofs.json');
  if (!fs.existsSync(proofsPath)) {
    throw new Error('bench-proofs.json not found. Run ./1-setup.sh first.');
  }

  console.log(`${LOG_PREFIX}Loading bench-proofs.json...`);
  const loadStart = Date.now();
  const benchProofs = JSON.parse(fs.readFileSync(proofsPath, 'utf-8'));
  const loadMs = Date.now() - loadStart;

  const { config, rootIndex, root, nullifiers, batches, proofStats, setupStats } = benchProofs;
  const TXS_PER_RELAY = config.batchCount;
  const totalBatches = batches.length;

  // ========== Calculate my batch slice ==========
  const base = Math.floor(totalBatches / BROADCASTER_COUNT);
  const rem = totalBatches % BROADCASTER_COUNT;
  const myStart = BROADCASTER_INDEX * base + Math.min(BROADCASTER_INDEX, rem);
  const myEnd = (BROADCASTER_INDEX + 1) * base + Math.min(BROADCASTER_INDEX + 1, rem);
  const myBatchCount = myEnd - myStart;
  const myTxCount = myBatchCount * TXS_PER_RELAY;

  // ========== Calculate rate limit ==========
  const myRateLimit = RATE_LIMIT > 0
    ? (BROADCASTER_COUNT > 1 ? Math.ceil(RATE_LIMIT / BROADCASTER_COUNT) : RATE_LIMIT)
    : 0;
  const relaysPerSecond = myRateLimit > 0 ? myRateLimit / TXS_PER_RELAY : 0;
  const delayMs = relaysPerSecond > 0 ? 1000 / relaysPerSecond : 0;

  if (BROADCASTER_INDEX === 0) {
    console.log('============================================');
    console.log('  Privacy Transact Benchmark (Submit)');
    console.log('============================================');
    console.log(`  Users: ${config.users}`);
    console.log(`  Total UOps: ${config.totalUop}`);
    console.log(`  Batch count: ${TXS_PER_RELAY}`);
    console.log(`  Circuit: ${config.inputsPerTx}-in / ${config.outputsPerTx}-out`);
    console.log(`  Total relay batches: ${totalBatches}`);
    console.log(`  Broadcasters: ${BROADCASTER_COUNT}`);
    console.log(`  Rate limit: ${RATE_LIMIT > 0 ? RATE_LIMIT + ' UOps/s' : 'unlimited'}`);
    console.log(`  Nullifiers to reset: ${nullifiers.length}`);
    console.log(`  Proofs loaded in ${loadMs}ms`);
    console.log('============================================\n');
  }

  console.log(`${LOG_PREFIX}My batches: ${myStart}..${myEnd - 1} (${myBatchCount} batches, ${myTxCount} txs)`);
  if (myRateLimit > 0) {
    console.log(`${LOG_PREFIX}Per-process rate limit: ${myRateLimit} UOps/s (${relaysPerSecond.toFixed(1)} relay/s, delay ${delayMs.toFixed(1)}ms)`);
  }

  // ========== Load deployment config ==========
  const configPath = path.join(__dirname, '../deployments.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('deployments.json not found. Run ./1-setup.sh first.');
  }
  const deployConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // ========== Connect contracts ==========
  const RailgunSmartWallet = await ethers.getContractFactory('RailgunSmartWalletStub', {
    libraries: { PoseidonT3: deployConfig.poseidonT3, PoseidonT4: deployConfig.poseidonT4 },
  });
  const railgun = RailgunSmartWallet.attach(deployConfig.proxy);
  const RelayAdapt = await ethers.getContractFactory('RelayAdapt');
  const relayAdapt = RelayAdapt.attach(deployConfig.relayAdaptProxy);

  // ========== Get deployer and derive broadcaster wallet ==========
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const masterKey = process.env.PRIVATE_KEY!;
  const myBroadcasterKey = deriveBroadcasterKey(masterKey, BROADCASTER_INDEX);
  const myBroadcaster = new ethers.Wallet(myBroadcasterKey, ethers.provider);
  console.log(`${LOG_PREFIX}Broadcaster address: ${myBroadcaster.address}`);

  // ========== Process 0: Reset chain state ==========
  if (BROADCASTER_INDEX === 0) {
    console.log('\n--- Resetting chain state (debugResetBenchState) ---\n');
    const resetStart = Date.now();
    const RESET_BATCH_SIZE = 1000;
    const totalBatches = Math.ceil(nullifiers.length / RESET_BATCH_SIZE);
    console.log(`  Clearing ${nullifiers.length} nullifiers in ${totalBatches} batches (batch size: ${RESET_BATCH_SIZE})`);

    let nonce = await deployer.getTransactionCount('latest');
    const txPromises: Promise<any>[] = [];

    for (let i = 0; i < nullifiers.length; i += RESET_BATCH_SIZE) {
      const chunk = nullifiers.slice(i, i + RESET_BATCH_SIZE);
      const tx = railgun.connect(deployer).debugResetBenchState(chunk, rootIndex, root, { nonce });
      txPromises.push(tx);
      nonce++;
    }

    // Send all without waiting for receipts, then wait for the last one to confirm
    const sentTxs = await Promise.all(txPromises);
    const lastTx = sentTxs[sentTxs.length - 1];
    await lastTx.wait();

    const resetMs = Date.now() - resetStart;
    console.log(`  Reset complete: ${resetMs}ms (${totalBatches} txs, ${nullifiers.length} nullifiers cleared)`);
  }

  // ========== Barrier sync ==========
  if (BARRIER_DIR) {
    // Signal ready
    fs.writeFileSync(path.join(BARRIER_DIR, `ready_d${BROADCASTER_INDEX}`), 'ready');
    console.log(`${LOG_PREFIX}Ready. Waiting for all broadcasters...`);

    // Wait for go signal (max 5 minutes)
    const goFile = path.join(BARRIER_DIR, 'go');
    for (let i = 0; i < 300; i++) {
      if (fs.existsSync(goFile)) break;
      await sleep(1000);
    }
    if (!fs.existsSync(goFile)) {
      throw new Error('Timeout waiting for barrier go signal');
    }
    console.log(`${LOG_PREFIX}Go signal received! Starting submission.`);
  }

  // ========== Deserialize my proofs ==========
  console.log(`${LOG_PREFIX}Deserializing proofs...`);
  const deserializeStart = Date.now();
  const myBatches = batches.slice(myStart, myEnd);
  const myBatchTransactions: PublicInputs[][] = myBatches.map((batch: any) =>
    batch.transactions.map(deserializePublicInputs),
  );
  const myActionData = myBatches.map((batch: any) => batch.actionData);
  const deserializeMs = Date.now() - deserializeStart;
  console.log(`${LOG_PREFIX}${myTxCount} proofs deserialized in ${deserializeMs}ms`);

  // ========== Submit relay batches with rate limiting ==========
  console.log(`\n${LOG_PREFIX}--- Submit Relay Calls ---\n`);

  const submitStart = Date.now();
  const baseNonce = await myBroadcaster.getTransactionCount('pending');

  console.log(`${LOG_PREFIX}Sending ${myBatchCount} relay calls...`);

  interface RelayResult {
    txHash: string;
    gasUsed: string;
    blockNumber: number;
  }

  const results: RelayResult[] = [];

  if (delayMs > 0) {
    // Rate-limited: submit one at a time with delay between calls
    for (let i = 0; i < myBatchTransactions.length; i++) {
      const batchStart = Date.now();

      const txResponse = await relayAdapt.connect(myBroadcaster).relay(
        myBatchTransactions[i],
        myActionData[i],
        { gasLimit: GAS_LIMIT_PER_RELAY, nonce: baseNonce + i },
      );

      // Don't wait for confirmation during rate-limited sending (fire-and-forget nonce tracking)
      // We'll wait for all confirmations after the sending loop
      results.push({ txHash: txResponse.hash, gasUsed: '0', blockNumber: 0 });

      if ((i + 1) % 100 === 0 || i === myBatchTransactions.length - 1) {
        console.log(`${LOG_PREFIX}  Sent ${i + 1}/${myBatchCount} relay calls`);
      }

      // Rate limiting: wait for remainder of tick
      const elapsed = Date.now() - batchStart;
      const waitTime = delayMs - elapsed;
      if (waitTime > 0) await sleep(waitTime);
    }
  } else {
    // Unlimited: fire all relay calls at once with pre-assigned nonces
    const txResponses = await Promise.all(
      myBatchTransactions.map(async (batchTxs, i) => {
        return relayAdapt.connect(myBroadcaster).relay(
          batchTxs,
          myActionData[i],
          { gasLimit: GAS_LIMIT_PER_RELAY, nonce: baseNonce + i },
        );
      }),
    );

    for (const tx of txResponses) {
      results.push({ txHash: tx.hash, gasUsed: '0', blockNumber: 0 });
    }
    console.log(`${LOG_PREFIX}  All ${myBatchCount} relay calls sent`);
  }

  // ========== Wait for all confirmations ==========
  console.log(`${LOG_PREFIX}Waiting for confirmations...`);
  const confirmStart = Date.now();

  let failedCount = 0;
  for (let i = 0; i < results.length; i++) {
    const receipt = await ethers.provider.waitForTransaction(results[i].txHash);
    results[i].gasUsed = receipt.gasUsed.toString();
    results[i].blockNumber = receipt.blockNumber;

    if (receipt.status === 0) {
      failedCount++;
      if (failedCount <= 3) {
        console.error(`${LOG_PREFIX}  WARNING: tx ${results[i].txHash} REVERTED (status=0)`);
      }
    }

    if ((i + 1) % 100 === 0 || i === results.length - 1) {
      console.log(`${LOG_PREFIX}  Confirmed ${i + 1}/${results.length}${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);
    }
  }
  if (failedCount > 0) {
    console.error(`${LOG_PREFIX}ERROR: ${failedCount}/${results.length} relay transactions REVERTED!`);
  }
  const confirmMs = Date.now() - confirmStart;
  const submitEnd = Date.now();

  console.log(`${LOG_PREFIX}All ${results.length} relay calls confirmed in ${confirmMs}ms`);

  // ========== Write per-process result JSON ==========
  const resultData = {
    broadcasterIndex: BROADCASTER_INDEX,
    broadcasterCount: BROADCASTER_COUNT,
    rateLimit: RATE_LIMIT,
    myRateLimit,
    batchRange: { start: myStart, end: myEnd },
    txCount: myTxCount,
    batchCount: myBatchCount,
    txsPerRelay: TXS_PER_RELAY,
    submitDurationMs: submitEnd - submitStart,
    confirmDurationMs: confirmMs,
    deserializeDurationMs: deserializeMs,
    loadDurationMs: loadMs,
    results,
  };

  const resultPath = path.join(__dirname, `../bench-result-d${BROADCASTER_INDEX}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));
  console.log(`${LOG_PREFIX}Results written to bench-result-d${BROADCASTER_INDEX}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
