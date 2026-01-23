/**
 * Browser-compatible Railgun Wallet API
 * This module provides a high-level API for managing Railgun wallets in the browser
 */

import { browserStorage } from './storage-browser';
import { IStorage, UTXOData, Keys, ScanState } from './types';
import { hexStringToArray, arrayToHexString, bigIntToArray, arrayToBigInt } from '../global/bytes';
import { SNARK_SCALAR_FIELD } from '../global/constants';
// Use browser-logic versions (already have crypto replaced)
import { TokenData, TokenType, Note, ShieldRequest, UnshieldNote, getTokenID } from '../browser-logic/note';
import { MerkleTree } from '../browser-logic/merkletree';
import { randomBytes, hash, ed25519, edBabyJubJub } from './crypto-browser';

// Type definitions for ethers.js (v5)
interface Provider {
  getNetwork(): Promise<{ chainId: number }>;
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt>;
}

interface TransactionReceipt {
  blockNumber: number;
  blockHash: string;
  transactionHash?: string; // Transaction hash (if available)
  hash?: string; // Alternative field name
  logs: Log[];
}

interface Log {
  address: string;
  topics: string[];
  data: string;
}

interface Contract {
  address: string;
  interface: {
    parseLog(log: Log): { name: string; args: any };
  };
}

/**
 * Global MerkleTree instance shared by all wallets
 */
let globalMerkleTree: MerkleTree | null = null;

/**
 * Storage key for MerkleTree persistence
 */
const MERKLE_TREE_STORAGE_KEY = 'railgun-merkle-tree';

/**
 * Save MerkleTree to localStorage
 */
function saveMerkleTreeToStorage(merkletree: MerkleTree): void {
  try {
    const serialized = merkletree.serialize();
    localStorage.setItem(MERKLE_TREE_STORAGE_KEY, JSON.stringify(serialized));
  } catch (e) {
    console.error('Failed to save MerkleTree to storage:', e);
  }
}

/**
 * Load MerkleTree from localStorage
 */
async function loadMerkleTreeFromStorage(): Promise<MerkleTree | null> {
  try {
    const data = localStorage.getItem(MERKLE_TREE_STORAGE_KEY);
    if (!data) {
      return null;
    }
    const serialized = JSON.parse(data);
    const merkletree = await MerkleTree.deserialize(serialized);
    return merkletree;
  } catch (e) {
    console.error('Failed to load MerkleTree from storage:', e);
    return null;
  }
}

/**
 * Get or create global MerkleTree
 * Tries to load from storage first, creates new one if not found
 */
async function getGlobalMerkleTree(): Promise<MerkleTree> {
  if (!globalMerkleTree) {
    // Try to load from storage first
    const loaded = await loadMerkleTreeFromStorage();
    if (loaded) {
      globalMerkleTree = loaded;
    } else {
      globalMerkleTree = await MerkleTree.createTree(0, 16);
      // Save the new tree to storage
      saveMerkleTreeToStorage(globalMerkleTree);
    }
  }
  return globalMerkleTree;
}

/**
 * Railgun Wallet Browser API
 */
class RailgunWalletBrowser {
  private storage: IStorage;
  private currentAccount: string | null = null;
  private provider: Provider | null = null;
  private contract: Contract | null = null;

  constructor(storage?: IStorage) {
    this.storage = storage || browserStorage;
  }

  /**
   * Initialize with provider and contract
   */
  async initialize(provider: Provider, contract: Contract): Promise<void> {
    this.provider = provider;
    this.contract = contract;
    
    // Ensure global MerkleTree is initialized
    await getGlobalMerkleTree();
  }

  /**
   * Get current Merkle root
   */
  getMerkleRoot(): Uint8Array | null {
    return globalMerkleTree ? globalMerkleTree.root : null;
  }

  /**
   * Set current account
   */
  setCurrentAccount(account: string): void {
    this.currentAccount = account.toLowerCase();
  }

  /**
   * Get current account
   */
  getCurrentAccount(): string | null {
    return this.currentAccount;
  }

  /**
   * Check if wallet has keys for account
   */
  async hasKeys(account: string): Promise<boolean> {
    const keys = await this.storage.loadKeys(account);
    return keys !== null;
  }

  /**
   * Generate keys from signature
   * @param account - Account address
   * @param signature - Signature from signing a message
   */
  async generateKeys(account: string, signature: string): Promise<Keys> {
    // Derive keys from signature (same logic as backend)
    const signatureBytes = hexStringToArray(signature);
    const spendingKey = await this.deriveKey(signatureBytes, 'spending');
    const viewingKey = await this.deriveKey(signatureBytes, 'viewing');

    const keys: Keys = {
      spendingKey: arrayToHexString(spendingKey, false),
      viewingKey: arrayToHexString(viewingKey, false),
    };

    await this.storage.saveKeys(account, keys);
    return keys;
  }

  /**
   * Derive key from signature
   */
  private deriveKey(signature: Uint8Array, type: 'spending' | 'viewing'): Uint8Array {
    // Use SHA256 hash of signature + type as key
    const message = new Uint8Array([...signature, ...new TextEncoder().encode(type)]);
    return hash.sha256(message);
  }

  /**
   * Get viewing public key from viewing key
   * @param viewingKey - Viewing key (hex string or Uint8Array)
   * @returns Viewing public key as Uint8Array
   */
  async getViewingPublicKey(viewingKey: string | Uint8Array): Promise<Uint8Array> {
    const viewingKeyArray = typeof viewingKey === 'string' 
      ? hexStringToArray(viewingKey.startsWith('0x') ? viewingKey : '0x' + viewingKey)
      : viewingKey;
    return ed25519.privateKeyToPublicKey(viewingKeyArray);
  }

  /**
   * Get MPK (Master Public Key) from spending key and viewing key
   * @param spendingKey - Spending key (hex string or Uint8Array)
   * @param viewingKey - Viewing key (hex string or Uint8Array)
   * @returns MPK as Uint8Array
   */
  async getMPK(spendingKey: string | Uint8Array, viewingKey: string | Uint8Array): Promise<Uint8Array> {
    const spendingKeyArray = typeof spendingKey === 'string'
      ? hexStringToArray(spendingKey.startsWith('0x') ? spendingKey : '0x' + spendingKey)
      : spendingKey;
    const viewingKeyArray = typeof viewingKey === 'string'
      ? hexStringToArray(viewingKey.startsWith('0x') ? viewingKey : '0x' + viewingKey)
      : viewingKey;
    
    // Calculate MPK: poseidon([spendingPublicKey[0], spendingPublicKey[1], nullifyingKey])
    const spendingPublicKey = await edBabyJubJub.privateKeyToPublicKey(spendingKeyArray);
    const nullifyingKey = await hash.poseidon([viewingKeyArray]);
    return await hash.poseidon([spendingPublicKey[0], spendingPublicKey[1], nullifyingKey]);
  }

  /**
   * Load keys for account
   */
  async loadKeys(account: string): Promise<Keys | null> {
    return await this.storage.loadKeys(account);
  }

  /**
   * Create Shield request
   * @param account - Account address
   * @param value - Amount to shield (in wei, as bigint or string)
   * @param tokenAddress - Token address
   * @param tokenType - Token type (0 = ERC20, 1 = ERC721, 2 = ERC1155)
   * @param tokenSubID - Token sub ID (for ERC721/ERC1155)
   */
  async createShieldRequest(
    account: string,
    value: bigint | string,
    tokenAddress: string,
    tokenType: number = 0,
    tokenSubID: bigint | string = 0n,
  ): Promise<ShieldRequest> {
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      throw new Error(`Keys not found for account: ${account}`);
    }

    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);
    const valueBigInt = typeof value === 'string' ? BigInt(value) : value;
    const tokenSubIDBigInt = typeof tokenSubID === 'string' ? BigInt(tokenSubID) : tokenSubID;

    const tokenData: TokenData = {
      tokenType: tokenType as TokenType,
      tokenAddress,
      tokenSubID: tokenSubIDBigInt,
    };

    // Create note (without keys)
    const noteRandom = randomBytes(16);
    const note = new Note(valueBigInt, noteRandom, tokenData, '');

    // Encrypt for shield (pass keys as parameters)
    const shieldRequest = await note.encryptForShield(spendingKey, viewingKey);
    return shieldRequest;
  }

  /**
   * Scan transaction for UTXOs
   * @param txHash - Transaction hash
   * @param account - Optional account to use for decryption. If provided, only this account's keys will be used.
   *                  If not provided, will try all registered accounts (for scanning historical transactions)
   */
  async scanTransaction(txHash: string, account?: string, knownTokens?: TokenData[]): Promise<void> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    const walletKeys: Array<{
      account: string;
      viewingKey: Uint8Array;
      spendingKey: Uint8Array;
    }> = [];

    if (account) {
      const keys = await this.storage.loadKeys(account);
      if (!keys) return;
      walletKeys.push({
        account,
        viewingKey: hexStringToArray(keys.viewingKey),
        spendingKey: hexStringToArray(keys.spendingKey),
      });
    } else {
      const registeredAccounts = await this.storage.getRegisteredAccounts();
      for (const acc of registeredAccounts) {
        const keys = await this.storage.loadKeys(acc);
        if (keys) {
          walletKeys.push({
            account: acc,
            viewingKey: hexStringToArray(keys.viewingKey),
            spendingKey: hexStringToArray(keys.spendingKey),
          });
        }
      }
    }
    
    if (walletKeys.length === 0) return;

    // Parse events and update MerkleTree
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === this.contract.address.toLowerCase()) {
        try {
          const parsedLog = this.contract.interface.parseLog(log);

          if (parsedLog.name === 'Shield') {
            await this.scanShieldEvent(parsedLog.args, walletKeys, receipt);
            await this.updateMerkleTreeFromShield(parsedLog.args);
          } else if (parsedLog.name === 'Transact') {
            await this.scanTransactEvent(parsedLog.args, walletKeys, receipt, knownTokens);
            await this.updateMerkleTreeFromTransact(parsedLog.args);
          } else if (parsedLog.name === 'Nullified') {
            await this.scanNullifiedEvent(parsedLog.args, walletKeys);
            await this.updateMerkleTreeFromNullified(parsedLog.args);
          }
        } catch (e) {
          // Skip
        }
      }
    }

    // Update scan state for all wallets
    const blockNumber = receipt.blockNumber;
    for (const wallet of walletKeys) {
      const scanState = await this.storage.getScanState(wallet.account);
      if (scanState) {
        await this.storage.updateScanState(wallet.account, {
          ...scanState,
          lastScannedBlock: blockNumber,
          lastScannedTime: Date.now(),
        });
      }
    }
  }

  /**
   * Scan Shield event
   */
  private async scanShieldEvent(
    args: any,
    walletKeys: Array<{ account: string; viewingKey: Uint8Array; spendingKey: Uint8Array }>,
    receipt: TransactionReceipt,
  ): Promise<void> {
    const startPosition = args.startPosition.toNumber();

    for (let i = 0; i < args.shieldCiphertext.length; i++) {
      const shieldCiphertext = args.shieldCiphertext[i];
      const commitment = args.commitments[i];

      const tokenData: TokenData = {
        tokenType: commitment.token.tokenType,
        tokenAddress: commitment.token.tokenAddress,
        tokenSubID: commitment.token.tokenSubID.toBigInt(),
      };

      const value = commitment.value.toBigInt();

      // Try to decrypt with wallet's viewingKey
      // Note: When account is specified in scanTransaction, walletKeys will only contain that account's keys
      let decrypted = false;
      for (const wallet of walletKeys) {
        try {
          // Convert shieldKey from bytes32 to Uint8Array
          // shieldKey is a public key (32 bytes) stored as bytes32 in contract
          const shieldKeyBytes = hexStringToArray(shieldCiphertext.shieldKey);
          if (walletKeys.length === 1) {
          } else {
          }

          const note = await Note.decryptShield(
            shieldKeyBytes,
            shieldCiphertext.encryptedBundle.map(hexStringToArray) as [
              Uint8Array,
              Uint8Array,
              Uint8Array,
            ],
            tokenData,
            value,
            wallet.viewingKey,
            wallet.spendingKey,
          );

          if (note) {
            // Save UTXO to this wallet (include account for key lookup)
            const utxo: UTXOData = {
              account: wallet.account, // Store account for key lookup
              npk: arrayToHexString(await note.getNotePublicKey(wallet.spendingKey, wallet.viewingKey), false),
              value: value.toString(),
              tokenAddress: tokenData.tokenAddress,
              tokenType: tokenData.tokenType,
              tokenSubID: tokenData.tokenSubID.toString(),
              random: arrayToHexString(note.random, false),
              leafIndex: startPosition + i,
              blockNumber: receipt.blockNumber,
              txHash: receipt.transactionHash || receipt.hash || receipt.blockHash, // Use transactionHash, not blockHash
              memo: note.memo,
            };

            await this.storage.addUTXO(wallet.account, utxo);
            // Format value for display (value is stored as string in wei)
            const valueFormatted = (BigInt(utxo.value) / 10n ** 18n).toString() + '.' + (BigInt(utxo.value) % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
            decrypted = true;
            break; // A note can only be decrypted by one viewingKey
          } else {
            if (walletKeys.length > 1) {
            } else {
              console.warn(`      ❌ Decryption failed - note may not belong to this account`);
            }
          }
        } catch (e) {
          // Continue to next wallet
        }
      }
      
      if (!decrypted) {
      }
    }
  }

  /**
   * Scan Transact event
   */
  private async scanTransactEvent(
    args: any,
    walletKeys: Array<{ account: string; viewingKey: Uint8Array; spendingKey: Uint8Array }>,
    receipt: TransactionReceipt,
    knownTokens?: TokenData[],
  ): Promise<void> {
    const startPosition = args.startPosition.toNumber();

    // Use commitmentCiphertext to match ABI naming
    const ciphertextArray = args.ciphertext || args.commitmentCiphertext;
    if (!ciphertextArray) {
      console.warn('No ciphertext found in Transact event');
      return;
    }

    // We need to know which tokens to try decrypting with
    // Get tokens from existing UTXOs for these wallets
    const tokensToTry: TokenData[] = [];
    const seenTokens = new Set<string>();
    
    // First, add any known tokens passed in
    if (knownTokens && knownTokens.length > 0) {
      for (const token of knownTokens) {
        const tokenKey = `${token.tokenType}-${token.tokenAddress}-${token.tokenSubID}`;
        if (!seenTokens.has(tokenKey)) {
          seenTokens.add(tokenKey);
          tokensToTry.push(token);
        }
      }
    }
    
    for (const wallet of walletKeys) {
      const utxos = await this.storage.getUTXOs(wallet.account);
      for (const utxo of utxos) {
        const tokenKey = `${utxo.tokenType}-${utxo.tokenAddress}-${utxo.tokenSubID}`;
        if (!seenTokens.has(tokenKey)) {
          seenTokens.add(tokenKey);
          tokensToTry.push({
            tokenType: utxo.tokenType,
            tokenAddress: utxo.tokenAddress,
            tokenSubID: BigInt(utxo.tokenSubID),
          });
        }
      }
    }
    
    // If no tokens found from UTXOs, try to get from all Shield events in receipt
    // This handles the case where recipient has no UTXOs yet
    if (tokensToTry.length === 0) {
      for (const log of receipt.logs) {
        try {
          const parsedLog = this.contract.interface.parseLog(log);
          if (parsedLog.name === 'Shield') {
            // Extract token from Shield event
            for (const commitment of parsedLog.args.commitments) {
              const tokenKey = `${commitment.token.tokenType}-${commitment.token.tokenAddress}-${commitment.token.tokenSubID}`;
              if (!seenTokens.has(tokenKey)) {
                seenTokens.add(tokenKey);
                tokensToTry.push({
                  tokenType: commitment.token.tokenType,
                  tokenAddress: commitment.token.tokenAddress,
                  tokenSubID: BigInt(commitment.token.tokenSubID.toString()),
                });
              }
            }
          }
        } catch (e) {
          // Skip logs that can't be parsed
        }
      }
    }
    
    // If still no tokens found, skip decryption
    if (tokensToTry.length === 0) {
      return;
    }
    
    tokensToTry.forEach((token, i) => {
    });
    
    for (let i = 0; i < ciphertextArray.length; i++) {
      const ciphertext = ciphertextArray[i];
      const hash = args.hash[i];
      
      let decrypted = false;

      // Try to decrypt with each wallet's viewingKey and each token
      for (const wallet of walletKeys) {
        for (const token of tokensToTry) {
          try {
            const note = await Note.decrypt(
              hexStringToArray(hash),
              {
                ciphertext: [
                  hexStringToArray(ciphertext.ciphertext[0]),
                  hexStringToArray(ciphertext.ciphertext[1]),
                  hexStringToArray(ciphertext.ciphertext[2]),
                  hexStringToArray(ciphertext.ciphertext[3]),
                ],
                blindedSenderViewingKey: hexStringToArray(ciphertext.blindedSenderViewingKey),
                blindedReceiverViewingKey: hexStringToArray(ciphertext.blindedReceiverViewingKey),
                annotationData: hexStringToArray(ciphertext.annotationData),
                memo: hexStringToArray(ciphertext.memo),
              },
              wallet.viewingKey,
              wallet.spendingKey,
              token,
            );

            if (note) {
              
              // Save UTXO to this wallet (include account for key lookup)
              const utxo: UTXOData = {
                account: wallet.account, // Store account for key lookup
                npk: arrayToHexString(await note.getNotePublicKey(wallet.spendingKey, wallet.viewingKey), false),
                value: note.value.toString(),
                tokenAddress: token.tokenAddress,
                tokenType: token.tokenType,
                tokenSubID: token.tokenSubID.toString(),
                random: arrayToHexString(note.random, false),
                leafIndex: startPosition + i,
                blockNumber: receipt.blockNumber,
                txHash: receipt.blockHash,
                memo: note.memo,
              };

              await this.storage.addUTXO(wallet.account, utxo);
              const valueEth = Number(note.value) / 1e18;
              decrypted = true;
              break; // A note can only be decrypted by one viewingKey
            } else {
            }
          } catch (e) {
            // Log decryption errors for debugging (AES decryption failure)
            // Continue to next wallet/token
          }
        }
        if (decrypted) break;
      }
      
      if (!decrypted) {
      }
    }
  }

  /**
   * Scan Nullified event
   */
  private async scanNullifiedEvent(
    args: any,
    walletKeys: Array<{ account: string; viewingKey: Uint8Array; spendingKey: Uint8Array }>,
  ): Promise<void> {
    const nullifiers = args.nullifiers || [];

    for (const nullifier of nullifiers) {
      const nullifierHex = typeof nullifier === 'string' ? nullifier : arrayToHexString(nullifier, false);

      // Add nullifier to all wallets (it might belong to any of them)
      for (const wallet of walletKeys) {
        await this.storage.addNullifier(wallet.account, nullifierHex, '');
      }
    }
  }

  /**
   * Get balance for account and token
   */
  async getBalance(account: string, tokenAddress: string, tokenType: number = 0): Promise<bigint> {
    const utxos = await this.getUnspentUTXOs(account, tokenAddress, tokenType);
    return utxos.reduce((sum: bigint, utxo: UTXOData) => sum + BigInt(utxo.value), 0n);
  }

  /**
   * Get UTXOs for account and token
   */
  async getUTXOs(account: string, tokenAddress: string, tokenType: number = 0): Promise<UTXOData[]> {
    return await this.storage.getUTXOsByToken(account, tokenAddress, tokenType);
  }

  /**
   * Register account (add to registered accounts list)
   */
  async registerAccount(account: string): Promise<void> {
    await this.storage.addRegisteredAccount(account);
  }

  /**
   * Get all registered accounts
   */
  async getRegisteredAccounts(): Promise<string[]> {
    return await this.storage.getRegisteredAccounts();
  }

  /**
   * Get unspent UTXOs (not nullified)
   */
  async getUnspentUTXOs(
    account: string,
    tokenAddress: string,
    tokenType: number = 0,
  ): Promise<UTXOData[]> {
    const utxos = await this.storage.getUTXOsByToken(account, tokenAddress, tokenType);
    
    // Get keys for calculating nullifiers
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      return utxos; // Can't check nullifiers without keys
    }
    
    const viewingKey = hexStringToArray(keys.viewingKey);
    const spendingKey = hexStringToArray(keys.spendingKey);
    const merkletree = await getGlobalMerkleTree();
    
    // Filter out UTXOs that have been nullified
    const unspentUTXOs: UTXOData[] = [];
    
    
    for (const utxo of utxos) {
      try {
        // Convert UTXO to Note to calculate nullifier
        const note = new Note(
          BigInt(utxo.value),
          hexStringToArray(utxo.random),
          {
            tokenType: utxo.tokenType as TokenType,
            tokenAddress: utxo.tokenAddress,
            tokenSubID: BigInt(utxo.tokenSubID),
          },
          utxo.memo || '',
        );
        
        // Calculate nullifier for this UTXO
        const nullifier = await note.getNullifier(viewingKey, utxo.leafIndex);
        const nullifierHex = arrayToHexString(nullifier, false);
        
        // Check if this nullifier has been used
        const isNullified = merkletree.nullifiers.some((n: Uint8Array) => 
          arrayToHexString(n, false) === nullifierHex
        );
        
        if (!isNullified) {
          unspentUTXOs.push(utxo);
        } else {
          const valueEth = Number(BigInt(utxo.value)) / 1e18;
        }
      } catch (e) {
        console.warn('Failed to check nullifier for UTXO:', e);
        // If we can't check, assume it's unspent (conservative)
        unspentUTXOs.push(utxo);
      }
    }
    
    return unspentUTXOs;
  }

  /**
   * Select UTXOs for a transaction (simple greedy algorithm)
   * Selects UTXOs that sum to at least the required amount
   */
  async selectUTXOs(
    account: string,
    amount: bigint,
    tokenAddress: string,
    tokenType: number = 0,
  ): Promise<UTXOData[]> {
    const unspentUTXOs = await this.getUnspentUTXOs(account, tokenAddress, tokenType);
    const selected: UTXOData[] = [];
    let total = 0n;

    for (const utxo of unspentUTXOs) {
      selected.push(utxo);
      total += BigInt(utxo.value);
      if (total >= amount) break;
    }

    return selected;
  }

  /**
   * Convert UTXO to Note (for transaction inputs)
   */
  async utxoToNote(utxo: UTXOData, account: string): Promise<Note> {
    return new Note(
      BigInt(utxo.value),
      hexStringToArray(utxo.random),
      {
        tokenType: utxo.tokenType as TokenType,
        tokenAddress: utxo.tokenAddress,
        tokenSubID: BigInt(utxo.tokenSubID),
      },
      utxo.memo || '',
    );
  }

  /**
   * Prepare unshield transaction inputs and outputs
   * 
   * @param account - Account address
   * @param amount - Amount to unshield (in wei, as bigint or string)
   * @param recipientAddress - Address to receive unshielded tokens
   * @param tokenAddress - Token address
   * @param tokenType - Token type (0 = ERC20, 1 = ERC721, 2 = ERC1155)
   * @param tokenSubID - Token sub ID (for ERC721/ERC1155)
   * @param numInputs - Number of input notes to use (default: auto-select minimum)
   * @param numOutputs - Number of output notes (default: 2, one change + one unshield)
   * @returns Transaction inputs and outputs
   */
  async prepareUnshieldTransaction(
    account: string,
    amount: bigint | string,
    recipientAddress: string,
    tokenAddress: string,
    tokenType: number = 0,
    tokenSubID: bigint | string = 0n,
    numInputs?: number,
    numOutputs: number = 2,
  ): Promise<{
    inputNotes: Note[];
    outputNotes: (Note | UnshieldNote)[];
    inputUTXOs: UTXOData[];
    tokenData: TokenData;
  }> {
    const keys = await this.storage.loadKeys(account);
    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);
    const valueBigInt = typeof amount === 'string' ? BigInt(amount) : amount;
    const tokenSubIDBigInt = typeof tokenSubID === 'string' ? BigInt(tokenSubID) : tokenSubID;

    const tokenData: TokenData = {
      tokenType: tokenType as TokenType,
      tokenAddress,
      tokenSubID: tokenSubIDBigInt,
    };

    const selectedUTXOs = await this.selectUTXOs(account, valueBigInt, tokenAddress, tokenType);
    const inputUTXOs = numInputs ? selectedUTXOs.slice(0, numInputs) : selectedUTXOs;
    const inputNotes = await Promise.all(inputUTXOs.map(utxo => this.utxoToNote(utxo, account)));
    const inputTotal = inputNotes.reduce((sum, note) => sum + note.value, 0n);
    const changeValue = inputTotal - valueBigInt;

    const outputNotes: (Note | UnshieldNote)[] = [];
    
    for (let i = 0; i < numOutputs - 1; i++) {
      outputNotes.push(new Note(
        i === 0 ? changeValue : 0n,
        randomBytes(16),
        tokenData,
        '',
      ));
    }

    outputNotes.push(new UnshieldNote(recipientAddress, valueBigInt, tokenData));
    
    return {
      inputNotes,
      outputNotes,
      inputUTXOs,
      tokenData,
    };
  }

  /**
   * Generate transaction data for unshield/transfer
   * This includes Merkle proofs, nullifiers, and commitment ciphertext
   * Note: SNARK proof generation is not included (requires WASM/zkey files)
   * 
   * @param account - Account address
   * @param inputNotes - Input notes (from prepareUnshieldTransaction)
   * @param outputNotes - Output notes (from prepareUnshieldTransaction)
   * @param chainID - Chain ID
   * @param minGasPrice - Minimum gas price (default: 0)
   * @param adaptContract - Adapt contract address (default: zero address)
   * @param adaptParams - Adapt parameters (default: empty)
   * @returns Transaction data ready for SNARK proof generation
   */
  async generateTransactionData(
    account: string,
    inputNotes: Note[],
    outputNotes: (Note | UnshieldNote)[],
    chainID: bigint,
    minGasPrice: bigint = 0n,
    adaptContract: string = '0x0000000000000000000000000000000000000000',
    adaptParams: Uint8Array = new Uint8Array(32),
  ): Promise<{
    merkleRoot: Uint8Array;
    nullifiers: Uint8Array[];
    commitments: Uint8Array[];
    merkleProofs: Array<{ element: Uint8Array; elements: Uint8Array[]; indices: number; root: Uint8Array }>;
    commitmentCiphertext: any[]; // CommitmentCiphertext[]
    boundParamsHash: Uint8Array;
    circuitInputs: any; // Partial CircuitInputs (without SNARK proof)
  }> {
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      throw new Error(`Keys not found for account: ${account}`);
    }

    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);

    // Get global MerkleTree
    const merkletree = await getGlobalMerkleTree();

    // Get Merkle root
    const merkleRoot = merkletree.root;

    // Get tree number (default: 0)
    const treeNumber = merkletree.treeNumber || 0;

    // Generate Merkle proofs for input notes
    const merkleProofs = await Promise.all(
      inputNotes.map(async (note) => {
        const noteHash = await note.getHash(spendingKey, viewingKey);
        return merkletree.generateProof(noteHash);
      }),
    );

    // Generate nullifiers
    const nullifiers = await Promise.all(
      inputNotes.map(async (note, index) => {
        const leafIndex = merkleProofs[index].indices;
        return note.getNullifier(viewingKey, leafIndex);
      }),
    );

    // Generate commitment hashes for output notes
    const commitments = await Promise.all(
      outputNotes.map(async (note) => {
        if (note instanceof UnshieldNote) {
          // UnshieldNote.getHash() doesn't need keys
          return note.getHash();
        }
        return note.getHash(spendingKey, viewingKey);
      }),
    );

    // Generate commitment ciphertext (for private notes only, not unshield)
    const commitmentCiphertext = await Promise.all(
      outputNotes.slice(0, outputNotes.length - 1).map(async (note) => {
        if (note instanceof UnshieldNote) {
          throw new Error('UnshieldNote should not be in ciphertext list');
        }
        return note.encrypt(spendingKey, viewingKey, viewingKey, false);
      }),
    );

    // Calculate bound params hash (simplified version - full version needs ethers ABI encoder)
    // For now, we'll use a simplified hash
    const boundParamsData = new Uint8Array([
      ...bigIntToArray(BigInt(treeNumber), 2),
      ...bigIntToArray(minGasPrice, 6),
      ...bigIntToArray(BigInt(1), 1), // UnshieldType.NORMAL
      ...bigIntToArray(chainID, 8),
      ...hexStringToArray(adaptContract),
      ...adaptParams,
    ]);
    const boundParamsHashRaw = hash.keccak256(boundParamsData);
    const boundParamsHash = bigIntToArray(
      (arrayToBigInt(boundParamsHashRaw) % SNARK_SCALAR_FIELD),
      32,
    );

    // Generate circuit inputs (partial - missing SNARK proof)
    const token = inputNotes[0].getTokenID();
    const publicKey = await inputNotes[0].getSpendingPublicKey(spendingKey);
    const signature = await inputNotes[0].sign(
      spendingKey,
      merkleRoot,
      boundParamsHash,
      nullifiers,
      commitments,
    );
    const randomIn = inputNotes.map((note) => note.random);
    const valueIn = inputNotes.map((note) => note.value);
    const pathElements = merkleProofs.map((proof) => proof.elements);
    const leavesIndices = merkleProofs.map((proof) => proof.indices);
    const nullifyingKey = await inputNotes[0].getNullifyingKey(viewingKey);
    const npkOut = await Promise.all(
      outputNotes.map(async (note) => {
        if (note instanceof UnshieldNote) {
          // UnshieldNote.getNotePublicKey() doesn't need keys
          return note.getNotePublicKey();
        }
        return note.getNotePublicKey(spendingKey, viewingKey);
      }),
    );
    const valueOut = outputNotes.map((note) => note.value);

    const circuitInputs = {
      // PUBLIC INPUTS
      merkleRoot: arrayToBigInt(merkleRoot),
      boundParamsHash: arrayToBigInt(boundParamsHash),
      nullifiers: nullifiers.map(arrayToBigInt),
      commitmentsOut: commitments.map(arrayToBigInt),

      // PRIVATE INPUTS
      token: arrayToBigInt(token),
      publicKey: publicKey.map(arrayToBigInt) as [bigint, bigint],
      signature: signature.map(arrayToBigInt) as [bigint, bigint, bigint],
      randomIn: randomIn.map(arrayToBigInt),
      valueIn,
      pathElements: pathElements.map((el) => el.map(arrayToBigInt)),
      leavesIndices,
      nullifyingKey: arrayToBigInt(nullifyingKey),
      npkOut: npkOut.map(arrayToBigInt),
      valueOut,
    };

    return {
      merkleRoot,
      nullifiers,
      commitments,
      merkleProofs,
      commitmentCiphertext,
      boundParamsHash,
      circuitInputs,
    };
  }

  /**
   * Create a dummy proof (all zeros) for testing
   * Since Verifier.sol always returns true, we just need to match the structure
   * Simulates proof generation delay (100ms)
   */
  private async createDummyProof(): Promise<{
    a: { x: bigint; y: bigint };
    b: { x: [bigint, bigint]; y: [bigint, bigint] };
    c: { x: bigint; y: bigint };
  }> {
    // Simulate proof generation delay (100ms)
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
      a: { x: 0n, y: 0n },
      b: {
        x: [0n, 0n],
        y: [0n, 0n],
      },
      c: { x: 0n, y: 0n },
    };
  }

  /**
   * Prepare private transfer transaction inputs and outputs
   * 
   * @param account - Sender account address
   * @param amount - Amount to transfer (in wei, as bigint or string)
   * @param recipientAddress - Recipient address (must be registered)
   * @param recipientViewingPublicKey - Recipient's viewing public key (hex string with 0x prefix)
   * @param tokenAddress - Token address
   * @param tokenType - Token type (0 = ERC20, 1 = ERC721, 2 = ERC1155)
   * @param tokenSubID - Token sub ID (for ERC721/ERC1155)
   * @param numInputs - Number of input notes to use (default: auto-select minimum)
   * @param numOutputs - Number of output notes (default: 2, one change + one recipient)
   * @returns Transaction inputs and outputs
   */
  async prepareTransferTransaction(
    account: string,
    amount: bigint | string,
    recipientAddress: string,
    recipientViewingPublicKey: string,
    tokenAddress: string,
    tokenType: number = 0,
    tokenSubID: bigint | string = 0n,
    numInputs?: number,
    numOutputs: number = 2,
  ): Promise<{
    inputNotes: Note[];
    outputNotes: Note[];
    inputUTXOs: UTXOData[];
    tokenData: TokenData;
    recipientNote: Note;
  }> {
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      throw new Error(`Keys not found for account: ${account}`);
    }

    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);
    const valueBigInt = typeof amount === 'string' ? BigInt(amount) : amount;
    const tokenSubIDBigInt = typeof tokenSubID === 'string' ? BigInt(tokenSubID) : tokenSubID;

    const tokenData: TokenData = {
      tokenType: tokenType as TokenType,
      tokenAddress,
      tokenSubID: tokenSubIDBigInt,
    };

    // Select UTXOs
    const selectedUTXOs = await this.selectUTXOs(account, valueBigInt, tokenAddress, tokenType);
    
    // Use specified number of inputs or use all selected
    const inputUTXOs = numInputs 
      ? selectedUTXOs.slice(0, numInputs)
      : selectedUTXOs;

    if (inputUTXOs.length === 0) {
      throw new Error('No UTXOs selected');
    }

    // Convert UTXOs to Notes
    const inputNotes = await Promise.all(
      inputUTXOs.map(utxo => this.utxoToNote(utxo, account))
    );

    // Calculate total input value
    const inputTotal = inputNotes.reduce((sum, note) => sum + note.value, 0n);

    // Validate that we have enough input value
    if (inputTotal < valueBigInt) {
      throw new Error(`Insufficient input value: have ${inputTotal}, need ${valueBigInt}`);
    }

    // Calculate change value (inputTotal - transfer amount)
    const changeValue = inputTotal - valueBigInt;

    // Create output notes
    const outputNotes: Note[] = [];
    
    // Create change notes (numOutputs - 1 change notes for sender)
    for (let i = 0; i < numOutputs - 1; i++) {
      const noteValue = i === 0 ? changeValue : 0n;  // First change gets all the change, others are 0
      const changeNote = new Note(
        noteValue,
        randomBytes(16),
        tokenData,
        '',
      );
      outputNotes.push(changeNote);
    }

    // Create recipient note (encrypted for recipient)
    const recipientNote = new Note(
      valueBigInt,
      randomBytes(16),
      tokenData,
      '', // memo 可以后续支持
    );
    outputNotes.push(recipientNote);
    
    return {
      inputNotes,
      outputNotes,
      inputUTXOs,
      tokenData,
      recipientNote,
    };
  }

  /**
   * Format transfer transaction for contract call (private to private)
   * 
   * @param account - Sender account address
   * @param inputNotes - Input notes
   * @param outputNotes - Output notes (last one is for recipient)
   * @param recipientMPK - Recipient's MPK (master public key, hex string)
   * @param recipientViewingPublicKey - Recipient's viewing public key (hex string)
   * @param chainID - Chain ID
   * @param minGasPrice - Minimum gas price
   * @param adaptContract - Adapt contract address
   * @param adaptParams - Adapt parameters
   * @param inputUTXOs - Optional: Input UTXOs
   * @returns Transaction ready for contract call
   */
  async formatTransferTransactionForContract(
    account: string,
    inputNotes: Note[],
    outputNotes: Note[],
    recipientMPK: string,
    recipientViewingPublicKey: string,
    chainID: bigint,
    minGasPrice: bigint = 0n,
    adaptContract: string = '0x0000000000000000000000000000000000000000',
    adaptParams: Uint8Array = new Uint8Array(32),
    inputUTXOs?: UTXOData[],
  ): Promise<{
    proof: { a: { x: bigint; y: bigint }; b: { x: [bigint, bigint]; y: [bigint, bigint] }; c: { x: bigint; y: bigint } };
    merkleRoot: Uint8Array;
    nullifiers: Uint8Array[];
    commitments: Uint8Array[];
    boundParams: {
      treeNumber: number;
      minGasPrice: bigint;
      unshield: number;
      chainID: bigint;
      adaptContract: string;
      adaptParams: Uint8Array;
      commitmentCiphertext: any[];
    };
    unshieldPreimage: {
      npk: Uint8Array;
      token: TokenData;
      value: bigint;
    };
  }> {
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      throw new Error(`Keys not found for account: ${account}`);
    }

    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);
    const recipientMasterPubKey = hexStringToArray(recipientMPK);
    const recipientViewingPubKey = hexStringToArray(recipientViewingPublicKey);

    // Get global MerkleTree
    const merkletree = await getGlobalMerkleTree();

    // Get Merkle root
    const merkleRoot = merkletree.root;

    // Get tree number (default: 0)
    const treeNumber = merkletree.treeNumber || 0;

    // For transfer: no unshield
    const unshieldType = 0;

    // Generate Merkle proofs for input notes
    const merkleProofs = await Promise.all(
      inputNotes.map(async (note, index) => {
        if (inputUTXOs && inputUTXOs[index] && inputUTXOs[index].leafIndex !== undefined) {
          return merkletree.generateProofByIndex(inputUTXOs[index].leafIndex);
        } else {
          const noteHash = await note.getHash(spendingKey, viewingKey);
          return merkletree.generateProof(noteHash);
        }
      }),
    );

    // Generate nullifiers
    const nullifiers = await Promise.all(
      inputNotes.map(async (note, index) => {
        const leafIndex = merkleProofs[index].indices;
        return note.getNullifier(viewingKey, leafIndex);
      }),
    );

    // Generate commitment hashes for output notes
    const commitments = await Promise.all(
      outputNotes.map(async (note, index) => {
        const isRecipient = index === outputNotes.length - 1;
        if (isRecipient) {
          // For recipient note, use their MPK (we don't have their spending key)
          return note.getHashWithMPK(recipientMasterPubKey);
        } else {
          // For sender's change note, use sender's keys
          return note.getHash(spendingKey, viewingKey);
        }
      }),
    );

    // Generate commitment ciphertext
    // Last note is for recipient, others are change notes for sender
    const commitmentCiphertext = await Promise.all(
      outputNotes.map(async (note, index) => {
        const isRecipient = index === outputNotes.length - 1;
        if (isRecipient) {
          // Encrypt for recipient using their MPK and viewing public key
          return note.encryptForReceiver(recipientMasterPubKey, viewingKey, recipientViewingPubKey, false);
        } else {
          // Encrypt for sender (change note)
          return note.encrypt(spendingKey, viewingKey, viewingKey, false);
        }
      }),
    );

    // For transfer: create a dummy unshield preimage (all zeros)
    const dummyUnshieldPreimage = {
      npk: new Uint8Array(32),
      token: outputNotes[0].tokenData,
      value: 0n,
    };

    // Create dummy proof
    const proof = await this.createDummyProof();

    return {
      proof,
      merkleRoot,
      nullifiers,
      commitments,
      boundParams: {
        treeNumber,
        minGasPrice,
        unshield: unshieldType,
        chainID,
        adaptContract,
        adaptParams,
        commitmentCiphertext,
      },
      unshieldPreimage: dummyUnshieldPreimage,
    };
  }

  /**
   * Format transaction for contract call
   * Creates a complete Transaction structure ready for railgun.transact()
   * 
   * @param account - Account address
   * @param inputNotes - Input notes
   * @param outputNotes - Output notes
   * @param chainID - Chain ID
   * @param minGasPrice - Minimum gas price
   * @param adaptContract - Adapt contract address
   * @param adaptParams - Adapt parameters
   * @param inputUTXOs - Optional: Input UTXOs (if provided, will use leafIndex for proof generation)
   * @returns Transaction ready for contract call
   */
  async formatTransactionForContract(
    account: string,
    inputNotes: Note[],
    outputNotes: (Note | UnshieldNote)[],
    chainID: bigint,
    minGasPrice: bigint = 0n,
    adaptContract: string = '0x0000000000000000000000000000000000000000',
    adaptParams: Uint8Array = new Uint8Array(32),
    inputUTXOs?: UTXOData[],
  ): Promise<{
    proof: { a: { x: bigint; y: bigint }; b: { x: [bigint, bigint]; y: [bigint, bigint] }; c: { x: bigint; y: bigint } };
    merkleRoot: Uint8Array;
    nullifiers: Uint8Array[];
    commitments: Uint8Array[];
    boundParams: {
      treeNumber: number;
      minGasPrice: bigint;
      unshield: number;
      chainID: bigint;
      adaptContract: string;
      adaptParams: Uint8Array;
      commitmentCiphertext: any[];
    };
    unshieldPreimage: {
      npk: Uint8Array;
      token: TokenData;
      value: bigint;
    };
  }> {
    const keys = await this.storage.loadKeys(account);
    if (!keys) {
      throw new Error(`Keys not found for account: ${account}`);
    }

    const spendingKey = hexStringToArray(keys.spendingKey);
    const viewingKey = hexStringToArray(keys.viewingKey);

    // Get global MerkleTree
    const merkletree = await getGlobalMerkleTree();

    // Get Merkle root
    const merkleRoot = merkletree.root;

    // Get tree number (default: 0)
    const treeNumber = merkletree.treeNumber || 0;

    // Determine unshield type (1 if last output is UnshieldNote, 0 otherwise)
    const unshieldType = outputNotes[outputNotes.length - 1] instanceof UnshieldNote ? 1 : 0;

    // Check if MerkleTree is empty (e.g., after page refresh)
    // If empty, we need to rebuild it from scanned transactions
    if (merkletree.length === 0) {
      // Check if we have UTXOs that suggest transactions were scanned before
      const allUTXOs = await this.storage.getUTXOs(account);
      if (allUTXOs.length > 0) {
        throw new Error(
          'MerkleTree is empty but UTXOs exist. ' +
          'This usually happens after refreshing the page. ' +
          'Please rescan all Shield/Transact transactions to rebuild the MerkleTree. ' +
          'You can do this by calling scanTransaction() for each transaction hash.'
        );
      }
    }

    // Generate Merkle proofs for input notes
    // If inputUTXOs are provided, use their leafIndex; otherwise, use hash lookup
    const merkleProofs = await Promise.all(
      inputNotes.map(async (note, index) => {
        if (inputUTXOs && inputUTXOs[index] && inputUTXOs[index].leafIndex !== undefined) {
          // Use leafIndex from UTXO if available
          return merkletree.generateProofByIndex(inputUTXOs[index].leafIndex);
        } else {
          // Fallback to hash lookup
          const noteHash = await note.getHash(spendingKey, viewingKey);
          return merkletree.generateProof(noteHash);
        }
      }),
    );

    // Generate nullifiers
    const nullifiers = await Promise.all(
      inputNotes.map(async (note, index) => {
        const leafIndex = merkleProofs[index].indices;
        return note.getNullifier(viewingKey, leafIndex);
      }),
    );

    // Generate commitment hashes for output notes
    const commitments = await Promise.all(
      outputNotes.map(async (note) => {
        if (note instanceof UnshieldNote) {
          return note.getHash();
        }
        return note.getHash(spendingKey, viewingKey);
      }),
    );

    // Generate commitment ciphertext (for private notes only, not unshield)
    const commitmentCiphertext = await Promise.all(
      outputNotes.slice(0, outputNotes.length - unshieldType).map(async (note) => {
        if (note instanceof UnshieldNote) {
          throw new Error('UnshieldNote should not be in ciphertext list');
        }
        return note.encrypt(spendingKey, viewingKey, viewingKey, false);
      }),
    );

    // Get unshield preimage (last output note)
    const lastNote = outputNotes[outputNotes.length - 1];
    const unshieldPreimage = {
      npk: lastNote instanceof UnshieldNote
        ? lastNote.getNotePublicKey()
        : await lastNote.getNotePublicKey(spendingKey, viewingKey),
      token: lastNote.tokenData,
      value: lastNote.value,
    };

    // Create dummy proof
    const proof = await this.createDummyProof();

    return {
      proof,
      merkleRoot,
      nullifiers,
      commitments,
      boundParams: {
        treeNumber,
        minGasPrice,
        unshield: unshieldType,
        chainID,
        adaptContract,
        adaptParams,
        commitmentCiphertext,
      },
      unshieldPreimage,
    };
  }

  /**
   * Update global MerkleTree from Shield event
   */
  private async updateMerkleTreeFromShield(args: any): Promise<void> {
    const merkletree = await getGlobalMerkleTree();
    const startPosition = args.startPosition.toNumber();
    
    // Calculate commitment hashes from commitments
    const leaves = await Promise.all(
      args.commitments.map(async (commitment: any) => {
        const tokenData: TokenData = {
          tokenType: commitment.token.tokenType,
          tokenAddress: commitment.token.tokenAddress,
          tokenSubID: commitment.token.tokenSubID.toBigInt(),
        };
        
        return hash.poseidon([
          hexStringToArray(commitment.npk),
          getTokenID(tokenData),
          bigIntToArray(commitment.value.toBigInt(), 32),
        ]);
      }),
    );

    // Insert leaves into global MerkleTree
    await merkletree.insertLeaves(leaves, startPosition);
    
    // Save MerkleTree to storage after update
    saveMerkleTreeToStorage(merkletree);
  }

  /**
   * Update global MerkleTree from Transact event
   */
  private async updateMerkleTreeFromTransact(args: any): Promise<void> {
    const merkletree = await getGlobalMerkleTree();
    const startPosition = args.startPosition.toNumber();
    
    // Get commitment hashes directly from event
    const leaves = args.hash.map((noteHash: string) => hexStringToArray(noteHash));

    // Insert leaves into global MerkleTree
    await merkletree.insertLeaves(leaves, startPosition);
    
    // Save MerkleTree to storage after update
    saveMerkleTreeToStorage(merkletree);
  }

  /**
   * Update global MerkleTree from Nullified event
   */
  private async updateMerkleTreeFromNullified(args: any): Promise<void> {
    const merkletree = await getGlobalMerkleTree();

    // Add nullifiers to global MerkleTree's nullifiers list
    const nullifiers = args.nullifier.map((nullifier: string) => hexStringToArray(nullifier));
    merkletree.nullifiers.push(...nullifiers);
    nullifiers.forEach((n: Uint8Array, i: number) => {
    });
    
    // Save MerkleTree to storage after update
    saveMerkleTreeToStorage(merkletree);
  }
}

export { RailgunWalletBrowser };
export default RailgunWalletBrowser;
