import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomiclabs/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';
import '@typechain/hardhat';
import 'hardhat-contract-sizer';
import 'hardhat-gas-reporter';
import 'solidity-coverage';
import 'hardhat-local-networks-config-plugin';

import './tasks';

import mocharc from './.mocharc.json';

// Load environment variables from .env file
import * as dotenv from 'dotenv';
dotenv.config();

// Determine if we're in local mode
const isLocal = process.env.LOCAL === 'true';

// Validate required environment variables in online mode
if (!isLocal) {
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.error('❌ Error: DEPLOYER_PRIVATE_KEY is required when LOCAL=false');
    console.error('   Please set it in .env file');
    process.exit(1);
  }
  if (!process.env.RPC_URL) {
    console.error('❌ Error: RPC_URL is required when LOCAL=false');
    console.error('   Please set it in .env file');
    process.exit(1);
  }
}

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      chainId: 1337,
      // Allow unlimited contract size for complex contracts like Railgun
      // This helps avoid "Contract code size exceeds EIP-170 limit" errors
      allowUnlimitedContractSize: true,
      // Increase gas limits to handle complex operations
      blockGasLimit: 30000000,
      gas: 12000000,
      // Note: EVM call stack depth is hardcoded to 1024 and cannot be changed
      // StackOverflow errors may occur if contract calls exceed this limit
      // This is a limitation of the EVM itself, not Hardhat
    },
    localhost: {
      url: isLocal ? (process.env.LOCAL_RPC || 'http://127.0.0.1:8545') : process.env.RPC_URL!,
      chainId: isLocal ? 1337 : parseInt(process.env.CHAIN_ID!),
      accounts: isLocal ? undefined : [process.env.DEPLOYER_PRIVATE_KEY!],
      allowUnlimitedContractSize: true,
      blockGasLimit: 30000000,
      gas: 12000000,
      gasPrice: isLocal ? undefined : 'auto',
    },
  },
  solidity: {
    compilers: [
      {
        version: '0.8.17',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          // Enable in future if contract size is an issue
          // Not enabling now because hardhat stack traces and
          // coverage reporting don't yet support it
          // viaIR: true,
          outputSelection: {
            '*': {
              '*': ['storageLayout'],
            },
          },
        },
      },
    ],
    overrides: {
      // Enable this to turn of viaIR for proxy contract
      // 'contracts/proxy/Proxy.sol': {
      //   version: '0.8.17',
      //   settings: {
      //     viaIR: false,
      //   },
      // },
    },
  },
  mocha: mocharc,
  gasReporter: {
    enabled: true,
    currency: 'USD',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
