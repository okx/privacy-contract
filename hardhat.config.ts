import crypto from 'crypto';
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

/**
 * Derive deterministic child private keys from a master key.
 * Used to generate broadcaster and user accounts from a single PRIVATE_KEY.
 */
function deriveAccounts(masterKey: string): string[] {
  const derive = (label: string) =>
    '0x' + crypto.createHash('sha256').update(masterKey + label).digest('hex');
  return [masterKey, derive('_broadcaster'), derive('_user')];
}

// Build localhost accounts: [deployer, broadcaster, user]
const localhostAccounts = process.env.PRIVATE_KEY ? deriveAccounts(process.env.PRIVATE_KEY) : [];

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    localhost: {
      url: process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545',
      accounts: localhostAccounts.length > 0 ? localhostAccounts : undefined,
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
