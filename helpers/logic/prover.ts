import { groth16, wtns } from 'snarkjs';
import type { SnarkjsProof } from 'snarkjs';
import type { Artifact } from 'railgun-circuit-test-artifacts';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============ CONFIGURATION ============
const USE_RAPIDSNARK = process.env.USE_RAPIDSNARK === 'true';
const RAPIDSNARK_MODE = process.env.RAPIDSNARK_MODE || 'local'; // 'local' or 'server'
const DEBUG_TIMING = process.env.DEBUG_TIMING === 'true';
const RAPIDSNARK_BIN_PATH = process.env.RAPIDSNARK_BIN_PATH || '/usr/local/bin/rapidsnark';
const RAPIDSNARK_SERVER_URL = process.env.RAPIDSNARK_SERVER_URL || 'http://localhost:8080';
const RAPIDSNARK_CIRCUIT = process.env.RAPIDSNARK_CIRCUIT || '02x03';

// Local circuits config (import from artifacts)
const USE_LOCAL_CIRCUITS = process.env.USE_LOCAL_CIRCUITS === 'true';
const LOCAL_CIRCUITS_PATH = process.env.LOCAL_CIRCUITS_PATH || path.join(__dirname, '../../../circuits-v2');

// Cache directory for artifact files (only used when NOT using local circuits)
const ARTIFACT_CACHE_DIR = path.join(os.tmpdir(), 'rapidsnark-artifacts');

// Ensure cache directory exists (only when needed)
if (USE_RAPIDSNARK && !USE_LOCAL_CIRCUITS && !fs.existsSync(ARTIFACT_CACHE_DIR)) {
  fs.mkdirSync(ARTIFACT_CACHE_DIR, { recursive: true });
}

// Cache for artifact file paths (keyed by hash of artifact content)
const artifactCache = new Map<string, { wasmPath: string; zkeyPath: string }>();

/**
 * Get circuit name from nullifiers/commitments (e.g., "02x03")
 */
function circuitConfigToName(nullifiers: number, commitments: number): string {
  return `${nullifiers.toString().padStart(2, '0')}x${commitments.toString().padStart(2, '0')}`;
}

/**
 * Get local artifact file paths directly (avoids /tmp copy)
 */
function getLocalFilePaths(nullifiers: number, commitments: number): { wasmPath: string; zkeyPath: string } {
  const name = circuitConfigToName(nullifiers, commitments);
  const buildDir = path.join(LOCAL_CIRCUITS_PATH, 'build');
  const zkeyDir = path.join(LOCAL_CIRCUITS_PATH, 'zkeys');

  return {
    wasmPath: path.join(buildDir, `${name}_js/${name}.wasm`),
    zkeyPath: path.join(zkeyDir, `${name}.zkey`),
  };
}

/**
 * Get or create cached artifact files (for non-local circuits)
 */
function getCachedArtifactPaths(artifact: Artifact): { wasmPath: string; zkeyPath: string } {
  // Use a simple hash based on file sizes (fast approximation)
  const cacheKey = `${artifact.wasm.length}_${artifact.zkey.length}`;

  if (artifactCache.has(cacheKey)) {
    const cached = artifactCache.get(cacheKey)!;
    // Verify files still exist
    if (fs.existsSync(cached.wasmPath) && fs.existsSync(cached.zkeyPath)) {
      return cached;
    }
  }

  // Write to cache
  const wasmPath = path.join(ARTIFACT_CACHE_DIR, `${cacheKey}.wasm`);
  const zkeyPath = path.join(ARTIFACT_CACHE_DIR, `${cacheKey}.zkey`);

  if (!fs.existsSync(wasmPath)) {
    fs.writeFileSync(wasmPath, artifact.wasm);
  }
  if (!fs.existsSync(zkeyPath)) {
    fs.writeFileSync(zkeyPath, artifact.zkey);
  }

  artifactCache.set(cacheKey, { wasmPath, zkeyPath });
  return { wasmPath, zkeyPath };
}

export interface SolidityProof {
  a: {
    x: bigint;
    y: bigint;
  };
  b: {
    x: [bigint, bigint];
    y: [bigint, bigint];
  };
  c: {
    x: bigint;
    y: bigint;
  };
}

export interface ProofBundle {
  javascript: SnarkjsProof;
  solidity: SolidityProof;
}

/**
 * Formats javascript proof to solidity proof
 *
 * @param proof - javascript proof
 * @returns solidity proof
 */
function formatProof(proof: SnarkjsProof): SolidityProof {
  return {
    a: { x: BigInt(proof.pi_a[0]), y: BigInt(proof.pi_a[1]) },
    b: {
      x: [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      y: [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    },
    c: { x: BigInt(proof.pi_c[0]), y: BigInt(proof.pi_c[1]) },
  };
}

/**
 * Generate proof using rapidsnark (C++ prover, ~10x faster)
 *
 * @param artifact - circuit artifact
 * @param inputs - circuit inputs
 * @param nullifiers - number of nullifiers (for local path lookup)
 * @param commitments - number of commitments (for local path lookup)
 * @returns proof
 */
async function proveWithRapidsnark(
  artifact: Artifact,
  inputs: unknown,
  nullifiers?: number,
  commitments?: number,
): Promise<ProofBundle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidsnark-'));

  try {
    // Get artifact file paths
    let wasmPath: string;
    let zkeyPath: string;

    if (USE_LOCAL_CIRCUITS && nullifiers !== undefined && commitments !== undefined) {
      // Use local file paths directly (no /tmp copy needed)
      const localPaths = getLocalFilePaths(nullifiers, commitments);
      wasmPath = localPaths.wasmPath;
      zkeyPath = localPaths.zkeyPath;
      if (DEBUG_TIMING) {
        console.log(`   📁 Using local circuit files directly: ${zkeyPath}`);
      }
    } else {
      // Fall back to cached artifact paths (writes to /tmp)
      const cached = getCachedArtifactPaths(artifact);
      wasmPath = cached.wasmPath;
      zkeyPath = cached.zkeyPath;
    }

    // Define temp file paths for this run
    const witnessPath = path.join(tmpDir, 'witness.wtns');
    const proofPath = path.join(tmpDir, 'proof.json');
    const publicPath = path.join(tmpDir, 'public.json');

    // Step 1: Generate witness using snarkjs (JS)
    const wtnsStart = Date.now();
    await wtns.calculate(inputs, wasmPath, witnessPath);
    const wtnsTime = Date.now() - wtnsStart;

    // Step 2: Generate proof using rapidsnark (C++)
    const proverStart = Date.now();
    execSync(`"${RAPIDSNARK_BIN_PATH}" "${zkeyPath}" "${witnessPath}" "${proofPath}" "${publicPath}"`, {
      stdio: 'pipe',
    });
    const proverTime = Date.now() - proverStart;

    if (DEBUG_TIMING) {
      console.log(`   ⏱️  prove: witness=${wtnsTime}ms, rapidsnark=${proverTime}ms`);
    }

    // Read and parse proof
    const proofJson = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));

    const proof: SnarkjsProof = {
      pi_a: proofJson.pi_a,
      pi_b: proofJson.pi_b,
      pi_c: proofJson.pi_c,
      protocol: proofJson.protocol || 'groth16',
      curve: proofJson.curve || 'bn128',
    };

    return {
      javascript: proof,
      solidity: formatProof(proof),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Generate proof using snarkjs (pure JavaScript)
 *
 * @param artifact - circuit artifact
 * @param inputs - circuit inputs
 * @returns proof
 */
async function proveWithSnarkjs(artifact: Artifact, inputs: unknown): Promise<ProofBundle> {
  const { proof } = await groth16.fullProve(inputs, artifact.wasm, artifact.zkey);
  return {
    javascript: proof,
    solidity: formatProof(proof),
  };
}

/**
 * Sleep utility for polling
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate proof using rapidsnark server (HTTP API)
 *
 * @param inputs - circuit inputs
 * @param circuit - circuit name (default from env)
 * @returns proof
 */
async function proveWithRapidsnarkServer(inputs: unknown, circuit: string = RAPIDSNARK_CIRCUIT): Promise<ProofBundle> {
  const proverStart = Date.now();

  // Custom replacer to handle BigInt serialization
  const bigIntReplacer = (_key: string, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  };

  // Step 1: Submit input to server
  const inputResponse = await fetch(`${RAPIDSNARK_SERVER_URL}/input/${circuit}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs, bigIntReplacer),
  });

  if (!inputResponse.ok) {
    throw new Error(`Failed to submit input to prover server: ${inputResponse.status}`);
  }

  // Step 2: Poll for status until complete
  let status: { status: string; proof?: string; pubData?: string; error?: string };
  do {
    await sleep(100); // Poll every 100ms
    const statusResponse = await fetch(`${RAPIDSNARK_SERVER_URL}/status`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!statusResponse.ok) {
      throw new Error(`Failed to get status from prover server: ${statusResponse.status}`);
    }

    status = await statusResponse.json();
  } while (status.status === 'busy');

  const proverTime = Date.now() - proverStart;

  if (DEBUG_TIMING) {
    console.log(`   ⏱️  prove: rapidsnark-server=${proverTime}ms`);
  }

  // Step 3: Handle result
  if (status.status === 'failed') {
    throw new Error(`Prover server failed: ${status.error}`);
  }

  if (status.status === 'aborted') {
    throw new Error('Prover server aborted');
  }

  if (status.status !== 'success' || !status.proof) {
    throw new Error(`Unexpected prover status: ${status.status}`);
  }

  // Parse proof from response
  const proofJson = JSON.parse(status.proof);

  const proof: SnarkjsProof = {
    pi_a: proofJson.pi_a,
    pi_b: proofJson.pi_b,
    pi_c: proofJson.pi_c,
    protocol: proofJson.protocol || 'groth16',
    curve: proofJson.curve || 'bn128',
  };

  return {
    javascript: proof,
    solidity: formatProof(proof),
  };
}

/**
 * Generate proof for a circuit
 * Uses rapidsnark based on RAPIDSNARK_MODE:
 *   - 'server': HTTP calls to rapidsnark prover server
 *   - 'local': local rapidsnark CLI (default)
 * If USE_RAPIDSNARK=false, uses snarkjs (JS)
 *
 * @param artifact - circuit artifact
 * @param inputs - circuit inputs
 * @param nullifiers - number of nullifiers (for local path lookup)
 * @param commitments - number of commitments (for local path lookup)
 * @returns proof
 */
async function prove(
  artifact: Artifact,
  inputs: unknown,
  nullifiers?: number,
  commitments?: number,
): Promise<ProofBundle> {
  console.log("USE_RAPIDSNARK", USE_RAPIDSNARK, "RAPIDSNARK_MODE", RAPIDSNARK_MODE);
  if (USE_RAPIDSNARK) {
    if (RAPIDSNARK_MODE === 'server') {
      return proveWithRapidsnarkServer(inputs);
    }
    return proveWithRapidsnark(artifact, inputs, nullifiers, commitments);
  }
  return proveWithSnarkjs(artifact, inputs);
}

export { formatProof, prove };
