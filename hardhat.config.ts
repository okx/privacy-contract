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

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
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
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
      // Same settings for localhost network (when using Hardhat node)
      allowUnlimitedContractSize: true,
      blockGasLimit: 30000000,
      gas: 12000000,
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
