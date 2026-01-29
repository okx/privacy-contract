#!/usr/bin/env ts-node
/**
 * Generate valid circuit input for testing 02x03 circuit
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from '../helpers/logic/wallet';
import { Note, TokenType } from '../helpers/logic/note';
import { randomBytes } from '../helpers/global/crypto';
import { MerkleTree } from '../helpers/logic/merkletree';
import { arrayToBigInt } from '../helpers/global/bytes';
import { hashBoundParams } from '../helpers/logic/transaction';

async function generateValidInput() {
  console.log('=== Generating Valid 02x03 Circuit Input ===\n');

  // Create merkle tree
  const merkletree = await MerkleTree.createTree();
  console.log('✓ MerkleTree created');

  // Create wallet
  const wallet = new Wallet(randomBytes(32), randomBytes(32));
  console.log('✓ Wallet created');

  // Token data
  const tokenData = {
    tokenType: TokenType.ERC20,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    tokenSubID: 0n,
  };

  // Create input notes (2 inputs for 02x03)
  const inputNotes = [
    new Note(
      wallet.spendingKey,
      wallet.viewingKey,
      10n ** 18n, // 1 token
      randomBytes(16),
      tokenData,
      ''
    ),
    new Note(
      wallet.spendingKey,
      wallet.viewingKey,
      2n * 10n ** 18n, // 2 tokens
      randomBytes(16),
      tokenData,
      ''
    ),
  ];

  // Create output notes (3 outputs for 02x03)
  const outputNotes = [
    new Note(
      wallet.spendingKey,
      wallet.viewingKey,
      10n ** 18n,
      randomBytes(16),
      tokenData,
      ''
    ),
    new Note(
      wallet.spendingKey,
      wallet.viewingKey,
      10n ** 18n,
      randomBytes(16),
      tokenData,
      ''
    ),
    new Note(
      wallet.spendingKey,
      wallet.viewingKey,
      10n ** 18n,
      randomBytes(16),
      tokenData,
      ''
    ),
  ];

  console.log('✓ Notes created (2 inputs, 3 outputs)');

  // Add notes to merkle tree
  const commitments = await Promise.all(inputNotes.map(note => note.getHash()));
  await merkletree.insertLeaves(commitments, 0);
  console.log('✓ Notes added to merkle tree');

  // Get merkle root
  const merkleRoot = merkletree.root;

  // Prepare bound params
  const treeNumber = merkletree.treeNumber;
  const minGasPrice = 0n;
  const unshield = 0; // No unshield
  const chainID = 1n; // Ethereum mainnet
  const adaptContract = '0x0000000000000000000000000000000000000000';
  const adaptParams = new Uint8Array(32);

  // Encrypt commitment ciphertext for outputs
  const commitmentCiphertext = await Promise.all(
    outputNotes.map((note) => note.encrypt(wallet.viewingKey, false))
  );

  // Hash bound params
  const boundParamsHash = hashBoundParams({
    treeNumber,
    minGasPrice,
    unshield,
    chainID,
    adaptContract,
    adaptParams,
    commitmentCiphertext,
  });

  // Get nullifiers
  const nullifiers = await Promise.all(
    inputNotes.map(async (note) => {
      const merkleProof = merkletree.generateProof(await note.getHash());
      return note.getNullifier(merkleProof.indices);
    })
  );

  // Get commitments out
  const commitmentsOut = await Promise.all(
    outputNotes.map((note) => note.getHash())
  );

  // Get private inputs
  const token = inputNotes[0].getTokenID();
  const publicKey = await inputNotes[0].getSpendingPublicKey();
  const signature = await inputNotes[0].sign(
    merkleRoot,
    boundParamsHash,
    nullifiers,
    commitmentsOut
  );
  const randomIn = inputNotes.map((note) => note.random);
  const valueIn = inputNotes.map((note) => note.value);

  const pathElements = await Promise.all(
    inputNotes.map(async (note) => {
      const merkleProof = merkletree.generateProof(await note.getHash());
      return merkleProof.elements;
    })
  );

  const leavesIndices = await Promise.all(
    inputNotes.map(async (note) => {
      const merkleProof = merkletree.generateProof(await note.getHash());
      return merkleProof.indices;
    })
  );

  const nullifyingKey = await inputNotes[0].getNullifyingKey();
  const npkOut = await Promise.all(
    outputNotes.map((note) => note.getNotePublicKey())
  );
  const valueOut = outputNotes.map((note) => note.value);

  // Format circuit inputs
  const circuitInputs = {
    // PUBLIC INPUTS
    merkleRoot: arrayToBigInt(merkleRoot).toString(),
    boundParamsHash: arrayToBigInt(boundParamsHash).toString(),
    nullifiers: nullifiers.map((n) => arrayToBigInt(n).toString()),
    commitmentsOut: commitmentsOut.map((c) => arrayToBigInt(c).toString()),

    // PRIVATE INPUTS
    token: arrayToBigInt(token).toString(),
    publicKey: publicKey.map((pk: Uint8Array) => arrayToBigInt(pk).toString()),
    signature: signature.map((s: Uint8Array) => arrayToBigInt(s).toString()),
    randomIn: randomIn.map((r) => arrayToBigInt(r).toString()),
    valueIn: valueIn.map((v) => v.toString()),
    pathElements: pathElements.map((pe) => pe.map((e: Uint8Array) => arrayToBigInt(e).toString())),
    leavesIndices: leavesIndices.map((li) => li.toString()),
    nullifyingKey: arrayToBigInt(nullifyingKey).toString(),
    npkOut: npkOut.map((npk) => arrayToBigInt(npk).toString()),
    valueOut: valueOut.map((v) => v.toString()),
  };

  console.log('✓ Circuit inputs formatted\n');

  // Save to rapidsnark directory
  const outputPath = path.join(__dirname, '../../rapidsnark/valid_input_02x03.json');
  fs.writeFileSync(outputPath, JSON.stringify(circuitInputs, null, 2));

  console.log('=== Valid Input Generated ===');
  console.log(`Saved to: ${outputPath}`);
  console.log('\nInput summary:');
  console.log(`  Merkle root: ${circuitInputs.merkleRoot.substring(0, 20)}...`);
  console.log(`  Nullifiers: ${circuitInputs.nullifiers.length}`);
  console.log(`  Commitments out: ${circuitInputs.commitmentsOut.length}`);
  console.log(`  Value in: ${valueIn.map(v => v.toString()).join(', ')}`);
  console.log(`  Value out: ${valueOut.map(v => v.toString()).join(', ')}`);
  console.log('\nThis input has valid EdDSA signatures and should pass all circuit constraints!');
}

generateValidInput().catch((error) => {
  console.error('Error generating input:', error);
  process.exit(1);
});
