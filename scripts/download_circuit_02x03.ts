import artifacts from 'railgun-circuit-test-artifacts';
import { getIPFSHash } from '../helpers/logic/artifactsIPFSHashes';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Download circuit artifact for 02x03 (2 nullifiers, 3 commitments)
 * 
 * This script downloads the circuit artifact from IPFS via the railgun-circuit-test-artifacts package
 * and saves it to the local directory structure expected by the codebase.
 * 
 * Usage:
 *   npx hardhat run scripts/download_circuit_02x03.ts
 * 
 * The artifact will be saved to:
 *   - build/02x03_js/02x03.wasm
 *   - zkeys/02x03.zkey
 *   - zkeys/02x03.vkey.json
 */

async function main() {
  const nullifiers = 2;
  const commitments = 3;
  const circuitName = '02x03';
  
  // Get IPFS hash for the circuit
  const ipfsHash = getIPFSHash(nullifiers, commitments);
  console.log(`📥 Downloading circuit ${circuitName} from IPFS`);
  console.log(`   IPFS Hash: ${ipfsHash}`);
  
  // Get artifact from the package (this downloads from IPFS)
  console.log(`   Fetching artifact from railgun-circuit-test-artifacts package...`);
  const artifact = artifacts.getArtifact(nullifiers, commitments);
  
  // Determine output directory (default to ./circuits-v2 or use env var)
  const outputDir = process.env.CIRCUITS_V2_DIR || path.join(__dirname, '../circuits-v2');
  const buildDir = path.join(outputDir, 'build');
  const zkeyDir = path.join(outputDir, 'zkeys');
  const wasmSubDir = path.join(buildDir, `${circuitName}_js`);
  
  // Create directories if they don't exist
  console.log(`   Creating directories...`);
  fs.mkdirSync(wasmSubDir, { recursive: true });
  fs.mkdirSync(zkeyDir, { recursive: true });
  
  // Save WASM file
  const wasmPath = path.join(wasmSubDir, `${circuitName}.wasm`);
  console.log(`   Saving WASM to: ${wasmPath}`);
  fs.writeFileSync(wasmPath, artifact.wasm);
  console.log(`   ✅ WASM saved (${(artifact.wasm.length / 1024 / 1024).toFixed(2)} MB)`);
  
  // Save zkey file
  const zkeyPath = path.join(zkeyDir, `${circuitName}.zkey`);
  console.log(`   Saving zkey to: ${zkeyPath}`);
  fs.writeFileSync(zkeyPath, artifact.zkey);
  console.log(`   ✅ zkey saved (${(artifact.zkey.length / 1024 / 1024).toFixed(2)} MB)`);
  
  // Save vkey JSON file
  const vkeyPath = path.join(zkeyDir, `${circuitName}.vkey.json`);
  console.log(`   Saving vkey to: ${vkeyPath}`);
  fs.writeFileSync(vkeyPath, JSON.stringify(artifact.vkey, null, 2));
  console.log(`   ✅ vkey saved`);
  
  console.log(`\n✅ Circuit ${circuitName} artifact downloaded successfully!`);
  console.log(`\nTo use these local circuits, set in your .env file:`);
  console.log(`   USE_LOCAL_CIRCUITS=true`);
  console.log(`   LOCAL_CIRCUITS_PATH=${outputDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
