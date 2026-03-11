/**
 * Bench Report: Aggregate results from multiple broadcaster processes and produce final report.
 *
 * Reads bench-result-d{i}.json files from all broadcaster processes, fetches block data,
 * and computes the overall TPS and gas metrics.
 *
 * Environment variables:
 *   BENCH_BROADCASTER_COUNT - Total broadcaster processes (default 1)
 *
 * Usage:
 *   npx hardhat run scripts/bench-report.ts --network localhost
 */
import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const BROADCASTER_COUNT = parseInt(process.env.BENCH_BROADCASTER_COUNT || '1', 10);

async function main() {
  // ========== Load all per-process results ==========
  console.log(`\nLoading results from ${BROADCASTER_COUNT} broadcaster(s)...`);

  interface ProcessResult {
    broadcasterIndex: number;
    broadcasterCount: number;
    rateLimit: number;
    myRateLimit: number;
    batchRange: { start: number; end: number };
    txCount: number;
    batchCount: number;
    txsPerRelay: number;
    submitDurationMs: number;
    confirmDurationMs: number;
    deserializeDurationMs: number;
    loadDurationMs: number;
    results: { txHash: string; gasUsed: string; blockNumber: number }[];
  }

  const processResults: ProcessResult[] = [];
  for (let i = 0; i < BROADCASTER_COUNT; i++) {
    const resultPath = path.join(__dirname, `../bench-result-d${i}.json`);
    if (!fs.existsSync(resultPath)) {
      throw new Error(`bench-result-d${i}.json not found. Broadcaster ${i} may have failed.`);
    }
    processResults.push(JSON.parse(fs.readFileSync(resultPath, 'utf-8')));
    console.log(`  Loaded bench-result-d${i}.json (${processResults[i].batchCount} batches, ${processResults[i].txCount} txs)`);
  }

  // ========== Load bench-proofs.json for setup/proof stats ==========
  const proofsPath = path.join(__dirname, '../bench-proofs.json');
  let proofStats: any = null;
  let setupStats: any = null;
  let benchConfig: any = null;
  if (fs.existsSync(proofsPath)) {
    const benchProofs = JSON.parse(fs.readFileSync(proofsPath, 'utf-8'));
    proofStats = benchProofs.proofStats;
    setupStats = benchProofs.setupStats;
    benchConfig = benchProofs.config;
  }

  // ========== Aggregate all receipts ==========
  const allResults = processResults.flatMap((p) => p.results);
  const totalTxCount = processResults.reduce((sum, p) => sum + p.txCount, 0);
  const totalBatchCount = processResults.reduce((sum, p) => sum + p.batchCount, 0);

  console.log(`\nFetching block data for ${allResults.length} relay calls...`);

  let totalGasUsed = ethers.BigNumber.from(0);
  let firstBlockNumber = Infinity;
  let lastBlockNumber = 0;
  let firstBlockTimestamp = Infinity;
  let lastBlockTimestamp = 0;

  // Cache block lookups to avoid redundant RPC calls
  const blockCache: Map<number, any> = new Map();

  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    totalGasUsed = totalGasUsed.add(r.gasUsed);

    if (!blockCache.has(r.blockNumber)) {
      blockCache.set(r.blockNumber, await ethers.provider.getBlock(r.blockNumber));
    }
    const block = blockCache.get(r.blockNumber)!;

    if (r.blockNumber < firstBlockNumber) {
      firstBlockNumber = r.blockNumber;
      firstBlockTimestamp = block.timestamp;
    }
    if (r.blockNumber > lastBlockNumber) {
      lastBlockNumber = r.blockNumber;
      lastBlockTimestamp = block.timestamp;
    }
  }

  // ========== Compute metrics ==========
  const maxSubmitDuration = Math.max(...processResults.map((p) => p.submitDurationMs));
  const submitDuration = maxSubmitDuration / 1000;
  const onChainDuration = lastBlockTimestamp - firstBlockTimestamp;
  const e2eTps = totalTxCount / submitDuration;
  const onChainTps = onChainDuration > 0 ? totalTxCount / onChainDuration : totalTxCount;
  const avgGasPerTx = totalGasUsed.div(totalTxCount);
  const globalRateLimit = processResults[0].rateLimit;
  const txsPerRelay = processResults[0].txsPerRelay;

  // ========== Print report ==========
  console.log('\n============================================');
  console.log('  Benchmark Report (Aggregated)');
  console.log('============================================');
  console.log('Config:');
  if (benchConfig) {
    console.log(`  Users: ${benchConfig.users}`);
    console.log(`  Circuit: ${benchConfig.inputsPerTx}-in / ${benchConfig.outputsPerTx}-out`);
  }
  console.log(`  Total Transactions: ${totalTxCount}`);
  console.log(`  TXs per Relay: ${txsPerRelay}`);
  console.log(`  Broadcasters: ${BROADCASTER_COUNT}`);
  console.log(`  Rate Limit: ${globalRateLimit > 0 ? globalRateLimit + ' UOps/s' : 'unlimited'}`);
  console.log('');

  if (setupStats) {
    console.log('Setup (from bench-setup):');
    console.log(`  Shield Gas: ${setupStats.shieldGas}`);
    console.log(`  Notes Created: ${setupStats.notesCreated}`);
    console.log(`  Setup Duration: ${setupStats.durationMs}ms`);
    console.log('');
  }

  if (proofStats) {
    console.log('Proof Generation (from bench-setup):');
    console.log(`  Total: ${proofStats.totalMs}ms (${proofStats.workers || 1} workers)`);
    console.log('');
  }

  console.log('Per-Broadcaster Submit:');
  for (const p of processResults) {
    const pSubmitSec = (p.submitDurationMs / 1000).toFixed(2);
    const pConfirmSec = (p.confirmDurationMs / 1000).toFixed(2);
    const pRate = p.myRateLimit > 0 ? `${p.myRateLimit} UOps/s` : 'unlimited';
    console.log(`  D${p.broadcasterIndex}: ${p.batchCount} batches, ${p.txCount} txs, submit=${pSubmitSec}s, confirm=${pConfirmSec}s, rate=${pRate}`);
  }
  console.log('');

  console.log('On-chain Results:');
  console.log(`  Total Relay Calls: ${totalBatchCount}`);
  console.log(`  Total Gas: ${totalGasUsed.toString()}`);
  console.log(`  Avg Gas/Tx: ${avgGasPerTx.toString()}`);
  console.log(`  Blocks: ${firstBlockNumber} -> ${lastBlockNumber} (${blockCache.size} unique blocks)`);
  console.log(`  On-chain Duration: ${onChainDuration}s`);
  console.log(`  On-chain TPS: ${onChainTps.toFixed(2)}`);
  console.log(`  E2E Submit Duration: ${submitDuration.toFixed(2)}s (slowest broadcaster)`);
  console.log(`  E2E TPS: ${e2eTps.toFixed(2)}`);
  console.log('============================================');

  // Write transaction hashes to temp file (appended to result file by 2-bench.sh)
  const hashLines = [
    '',
    'Transaction Hashes:',
    ...allResults.map((r, i) => `  Relay ${i + 1}: ${r.txHash}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, '../.bench-hashes.tmp'), hashLines);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
