/**
 * Browser-specific type definitions for Railgun wallet
 */

import { TokenData } from '../logic/note';

/**
 * Keys for a wallet
 */
export interface Keys {
  spendingKey: string; // hex string
  viewingKey: string;  // hex string
}

/**
 * UTXO data structure
 */
export interface UTXOData {
  account: string; // EOA address that owns this UTXO (used to lookup spendingKey/viewingKey)
  npk: string;
  value: string; // bigint as string
  tokenAddress: string;
  tokenType: number;
  tokenSubID: string; // bigint as string
  random: string; // hex string
  leafIndex?: number;
  blockNumber: number;
  txHash: string;
  memo?: string;
}

/**
 * Scan state for a wallet
 */
export interface ScanState {
  contractAddress: string;
  chainId: number;
  lastScannedBlock: number;
  lastScannedTime: number;
}

/**
 * Transaction data
 */
export interface TransactionData {
  account: string;
  type: 'shield' | 'unshield' | 'transfer';
  blockNumber: number;
  blockHash: string;
  encryptedData?: any;
  createdAt: number;
}

/**
 * Wallet data structure stored in localStorage
 */
export interface WalletData {
  spendingKey: string;
  viewingKey: string;
  createdAt: number;
  utxos: UTXOData[];
  scanState: ScanState;
  nullifiers: string[]; // hex strings
}

/**
 * Complete wallet storage structure
 */
export interface WalletStorage {
  registeredAccounts: string[]; // List of all accounts that have registered MPK
  wallets: {
    [account: string]: WalletData;
  };
  transactions: {
    [txHash: string]: TransactionData;
  };
}

/**
 * Storage interface
 */
export interface IStorage {
  // Wallet management
  saveWallet(account: string, walletData: WalletData): Promise<void>;
  loadWallet(account: string): Promise<WalletData | null>;
  getAllWallets(): Promise<string[]>; // Returns all account addresses that have wallet data
  deleteWallet(account: string): Promise<void>;

  // Keys management
  saveKeys(account: string, keys: Keys): Promise<void>;
  loadKeys(account: string): Promise<Keys | null>;

  // UTXO management
  addUTXO(account: string, utxo: UTXOData): Promise<void>;
  removeUTXO(account: string, nullifier: string): Promise<void>;
  getUTXOs(account: string): Promise<UTXOData[]>;
  getUTXOsByToken(account: string, tokenAddress: string, tokenType: number): Promise<UTXOData[]>;

  // Scan state
  updateScanState(account: string, scanState: Partial<ScanState>): Promise<void>;
  getScanState(account: string): Promise<ScanState | null>;

  // Transaction records
  saveTransaction(txHash: string, tx: TransactionData): Promise<void>;
  getTransaction(txHash: string): Promise<TransactionData | null>;

  // Nullifiers
  addNullifier(account: string, nullifier: string, txHash: string): Promise<void>;
  isNullifierSpent(account: string, nullifier: string): Promise<boolean>;

  // Registered accounts management
  addRegisteredAccount(account: string): Promise<void>;
  getRegisteredAccounts(): Promise<string[]>;
  removeRegisteredAccount(account: string): Promise<void>;
  isAccountRegistered(account: string): Promise<boolean>;
}
