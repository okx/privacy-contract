import {
  bigIntToArray,
  hexStringToArray,
  arrayToByteLength,
  combine,
  padToLength,
  railgunBase37,
  arrayToBigInt,
  arrayToHexString,
} from '../global/bytes';
import { SNARK_SCALAR_FIELD } from '../global/constants';
// Use browser-compatible crypto instead of Node.js crypto
import { hash, edBabyJubJub, aes, ed25519, randomBytes } from '../browser/crypto-browser';

export enum TokenType {
  'ERC20' = 0,
  'ERC721' = 1,
  'ERC1155' = 2,
}

export interface TokenData {
  tokenType: TokenType;
  tokenAddress: string;
  tokenSubID: bigint;
}

export interface CommitmentCiphertext {
  ciphertext: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  blindedSenderViewingKey: Uint8Array;
  blindedReceiverViewingKey: Uint8Array;
  annotationData: Uint8Array;
  memo: Uint8Array;
}

export interface ShieldCiphertext {
  // IV shared (16 bytes), tag (16 bytes), random (16 bytes), IV sender (16 bytes), receiver viewing public key (32 bytes)
  encryptedBundle: [Uint8Array, Uint8Array, Uint8Array];
  shieldKey: Uint8Array;
}

export interface CommitmentPreimage {
  npk: Uint8Array;
  token: TokenData;
  value: bigint;
}

export interface ShieldRequest {
  preimage: CommitmentPreimage;
  ciphertext: ShieldCiphertext;
}

/**
 * Gets token ID from token data
 *
 * @param tokenData - token data to get ID from
 * @returns token ID
 */
function getTokenID(tokenData: TokenData): Uint8Array {
  // ERC20 tokenID is just the address
  if (tokenData.tokenType === TokenType.ERC20) {
    return arrayToByteLength(hexStringToArray(tokenData.tokenAddress), 32);
  }

  // Other token types are the keccak256 hash of the token data
  return bigIntToArray(
    arrayToBigInt(
      hash.keccak256(
        combine([
          bigIntToArray(BigInt(tokenData.tokenType), 32),
          padToLength(hexStringToArray(tokenData.tokenAddress), 32, 'left'),
          bigIntToArray(tokenData.tokenSubID, 32),
        ]),
      ),
    ) % SNARK_SCALAR_FIELD,
    32,
  );
}

/**
 * Validate Token Data
 *
 * @param tokenData - token data to validate
 * @returns validity
 */
function validateTokenData(tokenData: TokenData): boolean {
  if (!Object.values(TokenType).includes(tokenData.tokenType)) return false;
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenData.tokenAddress)) return false;
  if (0n > tokenData.tokenSubID || tokenData.tokenSubID >= 2n ** 256n) return false;

  return true;
}

class Note {
  value: bigint;

  random: Uint8Array;

  tokenData: TokenData;

  memo: string;

  /**
   * Railgun Note
   * Note: spendingKey and viewingKey are not stored in Note for security.
   * They should be passed as parameters when needed, retrieved from the account's wallet.
   *
   * @param value - note value
   * @param random - note random field
   * @param tokenData - note token data
   * @param memo - note memo
   */
  constructor(
    value: bigint,
    random: Uint8Array,
    tokenData: TokenData,
    memo: string,
  ) {
    // Validate bounds
    if (value > 2n ** 128n - 1n) throw Error('Value too high');
    if (random.length !== 16) throw Error('Invalid random length');
    if (!validateTokenData(tokenData)) throw Error('Invalid token data');

    this.value = value;
    this.random = random;
    this.tokenData = tokenData;
    this.memo = memo;
  }

  /**
   * Get note nullifying key
   *
   * @param viewingKey - viewing key (from account's wallet)
   * @returns nullifying key
   */
  getNullifyingKey(viewingKey: Uint8Array): Promise<Uint8Array> {
    return hash.poseidon([viewingKey]);
  }

  /**
   * Get note spending public key
   *
   * @param spendingKey - spending key (from account's wallet)
   * @returns spending public key
   */
  getSpendingPublicKey(spendingKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
    return edBabyJubJub.privateKeyToPublicKey(spendingKey);
  }

  /**
   * Get note viewing public key
   *
   * @param viewingKey - viewing key (from account's wallet)
   * @returns viewing public key
   */
  getViewingPublicKey(viewingKey: Uint8Array): Promise<Uint8Array> {
    return ed25519.privateKeyToPublicKey(viewingKey);
  }

  /**
   * Get note master public key
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @returns master public key
   */
  async getMasterPublicKey(spendingKey: Uint8Array, viewingKey: Uint8Array): Promise<Uint8Array> {
    return hash.poseidon([
      ...(await this.getSpendingPublicKey(spendingKey)),
      await this.getNullifyingKey(viewingKey),
    ]);
  }

  /**
   * Get note public key
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @returns note public key
   */
  async getNotePublicKey(spendingKey: Uint8Array, viewingKey: Uint8Array): Promise<Uint8Array> {
    return hash.poseidon([
      await this.getMasterPublicKey(spendingKey, viewingKey),
      arrayToByteLength(this.random, 32),
    ]);
  }

  /**
   * Gets token ID from token data
   *
   * @returns token ID
   */
  getTokenID(): Uint8Array {
    return getTokenID(this.tokenData);
  }

  /**
   * Get note hash using provided MPK (for notes belonging to others)
   *
   * @param masterPublicKey - Master public key (MPK)
   * @returns hash
   */
  async getHashWithMPK(masterPublicKey: Uint8Array): Promise<Uint8Array> {
    // Calculate npk = poseidon([MPK, random])
    const npk = await hash.poseidon([
      masterPublicKey,
      arrayToByteLength(this.random, 32),
    ]);
    
    return hash.poseidon([
      npk,
      this.getTokenID(),
      bigIntToArray(this.value, 32),
    ]);
  }

  /**
   * Get note hash
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @returns hash
   */
  async getHash(spendingKey: Uint8Array, viewingKey: Uint8Array): Promise<Uint8Array> {
    return hash.poseidon([
      await this.getNotePublicKey(spendingKey, viewingKey),
      this.getTokenID(),
      bigIntToArray(this.value, 32),
    ]);
  }

  /**
   * Calculate nullifier
   *
   * @param viewingKey - viewing key (from account's wallet)
   * @param leafIndex - leaf index of note
   * @returns nullifier
   */
  async getNullifier(viewingKey: Uint8Array, leafIndex: number): Promise<Uint8Array> {
    return hash.poseidon([await this.getNullifyingKey(viewingKey), bigIntToArray(BigInt(leafIndex), 32)]);
  }

  /**
   * Sign a transaction
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param merkleRoot - transaction merkle root
   * @param boundParamsHash - transaction bound parameters hash
   * @param nullifiers - transaction nullifiers
   * @param commitmentsOut - transaction commitments
   * @returns signature
   */
  async sign(
    spendingKey: Uint8Array,
    merkleRoot: Uint8Array,
    boundParamsHash: Uint8Array,
    nullifiers: Uint8Array[],
    commitmentsOut: Uint8Array[],
  ): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
    const sighash = await hash.poseidon([
      merkleRoot,
      boundParamsHash,
      ...nullifiers,
      ...commitmentsOut,
    ]);

    return edBabyJubJub.signPoseidon(spendingKey, sighash);
  }

  /**
   * Gets commitment preimage
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @returns Commitment preimage
   */
  async getCommitmentPreimage(spendingKey: Uint8Array, viewingKey: Uint8Array): Promise<CommitmentPreimage> {
    return {
      npk: await this.getNotePublicKey(spendingKey, viewingKey),
      token: this.tokenData,
      value: this.value,
    };
  }

  /**
   * Encrypts random value for shield
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @returns encrypted random bundle
   */
  async encryptForShield(spendingKey: Uint8Array, viewingKey: Uint8Array): Promise<ShieldRequest> {
    // Generate a random key for testing
    // In the case of shielding from regular ETH address key should be generated as hash256(eth_sign(some_fixed_message))) from the ETH address of the shielder
    // In the case of shielding from a smart contract (eg. adapt module) a random 32 byte value should be used
    const shieldPrivateKey = randomBytes(32);

    // Get viewing public key
    const viewingPublicKey = await this.getViewingPublicKey(viewingKey);

    // Get shared key
    const sharedKey = ed25519.getSharedKey(shieldPrivateKey, viewingPublicKey);

    // Encrypt random (aes.gcm.encrypt is async in browser version)
    const encryptedRandom = await aes.gcm.encrypt([this.random], sharedKey);

    // Encrypt receiver public key (aes.ctr.encrypt is async in browser version)
    const encryptedReceiver = await aes.ctr.encrypt([viewingPublicKey], shieldPrivateKey);

    // Construct ciphertext
    const ciphertext: ShieldCiphertext = {
      encryptedBundle: [
        encryptedRandom[0],
        combine([encryptedRandom[1], encryptedReceiver[0]]),
        encryptedReceiver[1],
      ],
      shieldKey: await ed25519.privateKeyToPublicKey(shieldPrivateKey),
    };

    // Return shield request
    return {
      ciphertext,
      preimage: await this.getCommitmentPreimage(spendingKey, viewingKey),
    };
  }

  /**
   * Generates encrypted commitment bundle for a specific receiver
   *
   * @param receiverMasterPublicKey - receiver's master public key (MPK)
   * @param senderViewingPrivateKey - sender's viewing private key
   * @param receiverViewingPublicKey - receiver's viewing public key (hex string or Uint8Array)
   * @param blind - blind sender from receiver
   * @returns Ciphertext
   */
  async encryptForReceiver(
    receiverMasterPublicKey: Uint8Array,
    senderViewingPrivateKey: Uint8Array,
    receiverViewingPublicKey: Uint8Array | string,
    blind: boolean,
  ): Promise<CommitmentCiphertext> {
    // For contract tests always use output type of 0
    const outputType = 0n;

    // For contract tests always use this fixed application identifier
    const applicationIdentifier = railgunBase37.encode('railgun tests');

    // Get sender public key
    const senderViewingPublicKey = await ed25519.privateKeyToPublicKey(senderViewingPrivateKey);

    // Convert receiver public key if it's a hex string
    const receiverPubKey = typeof receiverViewingPublicKey === 'string'
      ? hexStringToArray(receiverViewingPublicKey)
      : receiverViewingPublicKey;

    // Get sender random, set to 0 is not blinding
    const senderRandom = blind ? randomBytes(15) : new Uint8Array(15);

    // Blind keys
    const blindedKeys = ed25519.railgunKeyExchange.blindKeys(
      senderViewingPublicKey,
      receiverPubKey,
      this.random,
      senderRandom,
    );

    // Get shared key
    const sharedKey = ed25519.getSharedKey(
      senderViewingPrivateKey,
      blindedKeys.blindedReceiverPublicKey,
    );

    // Encode memo text
    const memo = new TextEncoder().encode(this.memo);

    // Use receiver's master public key (MPK) - the note will belong to the receiver
    const masterPublicKey = receiverMasterPublicKey;

    // Pack plaintext blocks
    const tokenID = this.getTokenID();
    const plaintextBlocks = [
      masterPublicKey, // [0]: 32 bytes - receiver's MPK
      combine([this.random, bigIntToArray(this.value, 16)]), // [1]: random(16) + value(16) = 32 bytes
      tokenID, // [2]: 32 bytes
      memo, // [3]: variable length
    ];

    // Encrypt shared bundle (aes.gcm.encrypt is async in browser version)
    const encryptedSharedBundle = await aes.gcm.encrypt(
      plaintextBlocks,
      sharedKey,
    );

    // Browser version returns only 2 elements: [iv+tag (32 bytes), combined_ciphertext]
    // We need to split the combined_ciphertext back into individual blocks
    // to match the Node.js version format: [iv+tag, block1, block2, block3, block4]
    const ivAndTag = encryptedSharedBundle[0]; // 32 bytes: 16 bytes IV + 16 bytes tag
    const combinedCiphertext = encryptedSharedBundle[1]; // All encrypted blocks combined

    // Calculate block sizes (same as plaintext block sizes)
    const blockSizes = plaintextBlocks.map(block => block.length);
    // Split combined ciphertext back into individual blocks
    const encryptedBlocks: Uint8Array[] = [];
    let offset = 0;
    for (const blockSize of blockSizes) {
      encryptedBlocks.push(combinedCiphertext.slice(offset, offset + blockSize));
      offset += blockSize;
    }

    // Encrypt sender ciphertext (aes.ctr.encrypt is async in browser version)
    const encryptedSenderBundle = await aes.ctr.encrypt(
      [combine([bigIntToArray(outputType, 1), senderRandom, applicationIdentifier])],
      senderViewingPrivateKey,
    );

    // Return formatted commitment bundle matching Node.js version format
    // Node.js version: [iv+tag, block1, block2, block3, block4]
    return {
      ciphertext: [
        ivAndTag, // [0]: IV + tag (32 bytes)
        encryptedBlocks[0], // [1]: masterPublicKey encrypted (32 bytes)
        encryptedBlocks[1], // [2]: random+value encrypted (32 bytes)
        encryptedBlocks[2], // [3]: tokenID encrypted (32 bytes)
      ],
      blindedSenderViewingKey: blindedKeys.blindedSenderPublicKey,
      blindedReceiverViewingKey: blindedKeys.blindedReceiverPublicKey,
      annotationData: combine(encryptedSenderBundle),
      memo: encryptedBlocks[3] || new Uint8Array(0), // [4]: memo encrypted
    };
  }

  /**
   * Generates encrypted commitment bundle
   *
   * @param spendingKey - spending key (from account's wallet)
   * @param viewingKey - viewing key (from account's wallet)
   * @param senderViewingPrivateKey - sender's viewing private key
   * @param blind - blind sender from receiver
   * @returns Ciphertext
   */
  async encrypt(
    spendingKey: Uint8Array,
    viewingKey: Uint8Array,
    senderViewingPrivateKey: Uint8Array,
    blind: boolean,
  ): Promise<CommitmentCiphertext> {
    // For contract tests always use output type of 0
    const outputType = 0n;

    // For contract tests always use this fixed application identifier
    const applicationIdentifier = railgunBase37.encode('railgun tests');

    // Get sender public key
    const senderViewingPublicKey = await ed25519.privateKeyToPublicKey(senderViewingPrivateKey);

    // Get receiver viewing public key
    const receiverViewingPublicKey = await this.getViewingPublicKey(viewingKey);

    // Get sender random, set to 0 is not blinding
    const senderRandom = blind ? randomBytes(15) : new Uint8Array(15);

    // Blind keys
    const blindedKeys = ed25519.railgunKeyExchange.blindKeys(
      senderViewingPublicKey,
      receiverViewingPublicKey,
      this.random,
      senderRandom,
    );

    // Get shared key
    const sharedKey = ed25519.getSharedKey(
      senderViewingPrivateKey,
      blindedKeys.blindedReceiverPublicKey,
    );

    // Encode memo text
    const memo = new TextEncoder().encode(this.memo);

    // Get master public key
    const masterPublicKey = await this.getMasterPublicKey(spendingKey, viewingKey);

    // Prepare plaintext blocks (same as Node.js version)
    const plaintextBlocks = [
      masterPublicKey,
      combine([this.random, bigIntToArray(this.value, 16)]),
      this.getTokenID(),
      memo,
    ];

    // Encrypt shared ciphertext (aes.gcm.encrypt is async in browser version)
    // Browser version returns [iv+tag, combined_ciphertext] instead of [iv+tag, block1, block2, block3, block4]
    const encryptedSharedBundle = await aes.gcm.encrypt(
      plaintextBlocks,
      sharedKey,
    );

    // Browser version returns only 2 elements: [iv+tag (32 bytes), combined_ciphertext]
    // We need to split the combined_ciphertext back into individual blocks
    // to match the Node.js version format: [iv+tag, block1, block2, block3, block4]
    const ivAndTag = encryptedSharedBundle[0]; // 32 bytes: 16 bytes IV + 16 bytes tag
    const combinedCiphertext = encryptedSharedBundle[1]; // All encrypted blocks combined

    // Calculate block sizes (same as plaintext block sizes)
    const blockSizes = plaintextBlocks.map(block => block.length);
    // Split combined ciphertext back into individual blocks
    const encryptedBlocks: Uint8Array[] = [];
    let offset = 0;
    for (const blockSize of blockSizes) {
      encryptedBlocks.push(combinedCiphertext.slice(offset, offset + blockSize));
      offset += blockSize;
    }

    // Encrypt sender ciphertext (aes.ctr.encrypt is async in browser version)
    const encryptedSenderBundle = await aes.ctr.encrypt(
      [combine([bigIntToArray(outputType, 1), senderRandom, applicationIdentifier])],
      senderViewingPrivateKey,
    );

    // Return formatted commitment bundle matching Node.js version format
    // Node.js version: [iv+tag, block1, block2, block3, block4]
    return {
      ciphertext: [
        ivAndTag, // [0]: IV + tag (32 bytes)
        encryptedBlocks[0], // [1]: masterPublicKey encrypted (32 bytes)
        encryptedBlocks[1], // [2]: random+value encrypted (32 bytes)
        encryptedBlocks[2], // [3]: tokenID encrypted (32 bytes)
      ],
      blindedSenderViewingKey: blindedKeys.blindedSenderPublicKey,
      blindedReceiverViewingKey: blindedKeys.blindedReceiverPublicKey,
      annotationData: combine(encryptedSenderBundle),
      memo: encryptedBlocks[3] || new Uint8Array(0), // [4]: memo encrypted
    };
  }

  /**
   * Decrypts shielded note
   *
   * @param shieldKey - ephemeral key to us ein decryption
   * @param encryptedBundle - encrypted bundle to decrypt
   * @param token - token data
   * @param value - note value
   * @param viewingKey - viewing private key to try decrypting for
   * @param spendingKey - spending private key to use in decrypted note
   * @returns decrypted note or undefined if decryption failed
   */
  static async decryptShield(
    shieldKey: Uint8Array,
    encryptedBundle: [Uint8Array, Uint8Array, Uint8Array],
    token: TokenData,
    value: bigint,
    viewingKey: Uint8Array,
    spendingKey: Uint8Array,
  ): Promise<Note | undefined> {
    // Try to decrypt encrypted random
    try {
      // Get shared key
      const sharedKey = ed25519.getSharedKey(viewingKey, shieldKey);

      // Decrypt random (aes.gcm.decrypt is async in browser version)
      const decrypted = await aes.gcm.decrypt(
        [encryptedBundle[0], encryptedBundle[1].slice(0, 16)],
        sharedKey,
      );
      const random = decrypted[0];

      // Construct note (without keys)
      const note = new Note(value, random, token, '');

      return note;
    } catch {
      return undefined;
    }
  }

  /**
   * Decrypts note from encrypted bundle
   *
   * @param expectedHash - expected hash of note
   * @param encrypted - encrypted commitment bundle
   * @param viewingKey - viewing private key to try decrypting for
   * @param spendingKey - spending private key to use in decrypted note
   * @param tokenData - token data to use in decrypted note
   * @returns decrypted note or undefined if decryption failed,
   * spender key doesn't match, or token data doesn't match
   */
  static async decrypt(
    expectedHash: Uint8Array,
    encrypted: CommitmentCiphertext,
    viewingKey: Uint8Array,
    spendingKey: Uint8Array,
    tokenData: TokenData,
  ): Promise<Note | undefined> {
    // Reconstruct encrypted shared bundle
    const encryptedSharedBundle: Uint8Array[] = [...encrypted.ciphertext, encrypted.memo];

    let sharedBundle: Uint8Array[];

    try {
      const sharedKey = ed25519.getSharedKey(viewingKey, encrypted.blindedSenderViewingKey);
      const decrypted = await aes.gcm.decrypt(encryptedSharedBundle, sharedKey);
      
      // Browser version returns combined plaintext, split it
      if (decrypted.length === 1) {
        const combinedPlaintext = decrypted[0];
        sharedBundle = [
          combinedPlaintext.slice(0, 32),
          combinedPlaintext.slice(32, 64),
          combinedPlaintext.slice(64, 96),
        ];
        if (combinedPlaintext.length > 96) {
          sharedBundle.push(combinedPlaintext.slice(96));
        }
      } else {
        sharedBundle = decrypted;
      }
    } catch {
      return undefined;
    }
    
    if (!sharedBundle[1] || sharedBundle[1].length < 32) {
      return undefined;
    }

    const memo = sharedBundle.length > 3 ? new TextDecoder().decode(sharedBundle[3]) : '';
    const note = new Note(
      arrayToBigInt(sharedBundle[1].slice(16, 32)),
      sharedBundle[1].slice(0, 16),
      tokenData,
      memo.replace(/\u0000/g, ''),
    );

    const calculatedHash = await note.getHash(spendingKey, viewingKey);
    if (arrayToHexString(calculatedHash, false) === arrayToHexString(expectedHash, false)) {
      return note;
    }
    
    return undefined;
  }
}

class UnshieldNote {
  unshieldAddress: string;

  value: bigint;

  tokenData: TokenData;

  /**
   * Railgun Unshield
   *
   * @param unshieldAddress - address to unshield to
   * @param value - note value
   * @param tokenData - note token data
   */
  constructor(unshieldAddress: string, value: bigint, tokenData: TokenData) {
    // Validate bounds
    if (!/^0x[a-fA-F0-9]{40}$/.test(unshieldAddress)) throw Error('Invalid unshield address');
    if (value >= 2n ** 128n) throw Error('Value too high');
    if (!validateTokenData(tokenData)) throw Error('Invalid token data');

    this.unshieldAddress = unshieldAddress;
    this.value = value;
    this.tokenData = tokenData;
  }

  /**
   * Return unshield address as npk
   *
   * @returns npk
   */
  getNotePublicKey() {
    return arrayToByteLength(hexStringToArray(this.unshieldAddress), 32);
  }

  /**
   * Gets token ID from token data
   *
   * @returns token ID
   */
  getTokenID(): Uint8Array {
    return getTokenID(this.tokenData);
  }

  /**
   * Get note hash
   * Note: UnshieldNote doesn't need keys, it uses the unshield address directly
   *
   * @returns hash
   */
  async getHash(): Promise<Uint8Array> {
    return hash.poseidon([
      this.getNotePublicKey(),
      this.getTokenID(),
      bigIntToArray(this.value, 32),
    ]);
  }

  /**
   * Gets commitment preimage
   *
   * @returns Commitment preimage
   */
  getCommitmentPreimage(): CommitmentPreimage {
    return {
      npk: this.getNotePublicKey(),
      token: this.tokenData,
      value: this.value,
    };
  }

  /**
   * Return dummy ciphertext
   *
   * @returns Dummy ciphertext
   */
  encrypt(): CommitmentCiphertext {
    return {
      ciphertext: [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
      blindedSenderViewingKey: new Uint8Array(32),
      blindedReceiverViewingKey: new Uint8Array(32),
      annotationData: new Uint8Array(0),
      memo: new Uint8Array(0),
    };
  }
}

export { getTokenID, validateTokenData, Note, UnshieldNote };
