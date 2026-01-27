import { task } from 'hardhat/config';
import * as fs from 'fs';
import * as path from 'path';

import * as weth9artifact from '../../externalArtifacts/WETH9.json';

import { loadArtifacts, listArtifacts } from '../../helpers/logic/artifacts';
import type { Contract } from 'ethers';

/**
 * Log data to verify contract
 *
 * @param name - name of contract
 * @param contract - contract object
 * @param constructorArguments - constructor arguments
 * @returns promise resolved on deploy deployed
 */
async function logVerify(
  name: string,
  contract: Contract,
  constructorArguments: unknown[],
): Promise<null> {
  console.log(`\nDeploying ${name}`);
  console.log({
    address: contract.address,
    constructorArguments,
  });
  return contract.deployTransaction.wait().then();
}

task('deploy:test', 'Creates test environment deployment').setAction(async function (
  taskArguments,
  hre,
) {
  const { ethers } = hre;
  await hre.run('compile');

  // Get deployer account (validation already done in hardhat.config.ts)
  const isLocal = process.env.LOCAL === 'true';
  let deployer;
  
  if (isLocal) {
    console.log('Using default test account for deployment');
    deployer = (await ethers.getSigners())[0];
  } else {
    console.log('Using configured private key for deployment');
    deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  }
  console.log('Deployer address:', deployer.address);

  // Get build artifacts (using deployer account)
  const Delegator = await ethers.getContractFactory('Delegator', deployer);
  const PoseidonT3 = await ethers.getContractFactory('PoseidonT3', deployer);
  const PoseidonT4 = await ethers.getContractFactory('PoseidonT4', deployer);
  const Proxy = await ethers.getContractFactory('PausableUpgradableProxy', deployer);
  const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin', deployer);
  const RailToken = await ethers.getContractFactory('AdminERC20', deployer);
  const TestERC20 = await ethers.getContractFactory('TestERC20', deployer);
  const TestERC721 = await ethers.getContractFactory('TestERC721', deployer);
  const RelayAdapt = await ethers.getContractFactory('RelayAdapt', deployer);
  const MPKRegistry = await ethers.getContractFactory('MPKRegistry', deployer);
  const Staking = await ethers.getContractFactory('Staking', deployer);
  const TreasuryImplementation = await ethers.getContractFactory('Treasury', deployer);
  const Voting = await ethers.getContractFactory('Voting', deployer);

  // Deploy Poseidon libraries
  const poseidonT3 = await PoseidonT3.deploy();
  await logVerify('PoseidonT3', poseidonT3, []);
  
  const poseidonT4 = await PoseidonT4.deploy();
  await logVerify('PoseidonT4', poseidonT4, []);

  // Get Railgun Smart Wallet
  const RailgunSmartWallet = await ethers.getContractFactory('RailgunSmartWalletStub', {
    signer: deployer,
    libraries: {
      PoseidonT3: poseidonT3.address,
      PoseidonT4: poseidonT4.address,
    },
  });

  // Deploy RailToken
  const rail = await RailToken.deploy('RailTest', 'RAILTEST');
  await logVerify('AdminERC20', rail, ['RailTest', 'RAILTEST']);
  await rail.adminMint(deployer.address, 50000000n * 10n ** 18n);

  // Deploy Staking
  const staking = await Staking.deploy(rail.address);
  await logVerify('Staking', staking, [rail.address]);

  // Deploy delegator
  const delegator = await Delegator.deploy(deployer.address);
  await logVerify('Delegator', delegator, [deployer.address]);

  // Deploy voting
  const voting = await Voting.deploy(staking.address, delegator.address);
  await logVerify('Voting', voting, [staking.address, delegator.address]);

  // Deploy treasury implementation
  const treasuryImplementation = await TreasuryImplementation.deploy();
  await logVerify('Treasury Implementation', treasuryImplementation, []);

  // Deploy ProxyAdmin
  const proxyAdmin = await ProxyAdmin.deploy(deployer.address);
  await logVerify('Proxy Admin', proxyAdmin, [deployer.address]);

  // Deploy treasury proxy
  const treasuryProxy = await Proxy.deploy(proxyAdmin.address);
  await logVerify('Treasury Proxy', treasuryProxy, [proxyAdmin.address]);

  // Deploy Proxy
  const proxy = await Proxy.deploy(proxyAdmin.address);
  await logVerify('Proxy', proxy, [proxyAdmin.address]);

  // Deploy Implementation
  const implementation = await RailgunSmartWallet.deploy();
  await logVerify('Implementation', implementation, []);

  // Set implementation for proxies
  console.log('\nSetting proxy implementations');
  await (await proxyAdmin.upgrade(proxy.address, implementation.address)).wait();
  await (await proxyAdmin.unpause(proxy.address)).wait();
  await (await proxyAdmin.upgrade(treasuryProxy.address, treasuryImplementation.address)).wait();
  await (await proxyAdmin.unpause(treasuryProxy.address)).wait();

  // Get proxied contracts
  const treasury = TreasuryImplementation.attach(treasuryProxy.address);
  const railgun = RailgunSmartWallet.attach(proxy.address);

  // Initialize contracts
  console.log('\nInitializing contracts');
  await (await treasury.initializeTreasury(delegator.address)).wait();
  await (
    await railgun.initializeRailgunLogic(
      treasuryProxy.address,
      25n,
      25n,
      25n,
      deployer.address,
      { gasLimit: 2000000 },
    )
  ).wait();

  // Set artifacts
  console.log('\nSetting Artifacts');
  
  // Custom circuit list: inputs 1-10, outputs 1 or 2 (20 circuits total)
  const customCircuits = [];
  for (let nullifiers = 1; nullifiers <= 10; nullifiers++) {
    for (let commitments = 1; commitments <= 2; commitments++) {
      customCircuits.push({ nullifiers, commitments });
    }
  }
  
  console.log(`Loading ${customCircuits.length} circuits (inputs: 1-10, outputs: 1-2)...`);
  await loadArtifacts(railgun, customCircuits);
  console.log('✅ All circuits loaded');

  // Give deployer address full permissions
  console.log(`\nGiving full governance permissions to ${deployer.address}`);
  await delegator.setPermission(
    deployer.address,
    ethers.constants.AddressZero,
    '0x00000000',
    true,
  );

  // Transfer contract ownerships
  console.log('\nTransferring ownerships');
  await (await railgun.transferOwnership(delegator.address)).wait();
  await (await proxyAdmin.transferOwnership(delegator.address)).wait();
  await (await delegator.transferOwnership(voting.address)).wait();

  // Deploy WETH9
  const WETH9 = new ethers.ContractFactory(
    weth9artifact.abi,
    weth9artifact.bytecode,
    deployer,
  );
  const weth9 = await WETH9.deploy();
  await logVerify('WETH9', weth9, []);

  // Deploy RelayAdapt
  const relayAdapt = await RelayAdapt.deploy(proxy.address, weth9.address);
  await logVerify('Relay Adapt', relayAdapt, [proxy.address, weth9.address]);

  // Deploy test tokens
  const testERC20 = await TestERC20.deploy();
  await logVerify('Test ERC20', testERC20, []);

  // Mint 10000 tokens to specified addresses
  const mintAmount = ethers.utils.parseEther('10000');
  
  // Select addresses based on LOCAL mode
  const localAddresses = [
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',  // Hardhat account #1
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',  // Hardhat account #2
  ];
  
  const onlineAddresses = [
    '0x694a97f84ceda9CfAF9e2A7fd40E05074207C4F7',
    '0x0099fFe96Ee19D1d70DA691A660972de8A3d19BB',
    '0x370427e759a84fdFfed8b948DAe21afF1167f018',
    '0x89EeA4015aC3DB922d9d1fFaC1E67Bc61650a20B',
    '0x6c589b529Cb92576dC549e57fd637D8629948844',
    '0xaD22c97b121Ef5313A934a10Edc510947982e283',
    '0x038352a4e8b7e36904e1b5C670E8ae00deA1FBB1',
    '0xA14a8bFf55bC15A64961393a0CdE1F90D1aF5B5A',
  ];
  
  const addressesToMint = isLocal ? localAddresses : onlineAddresses;
  
  console.log(`\nMinting to ${addressesToMint.length} addresses (${isLocal ? 'LOCAL' : 'ONLINE'} mode)...`);

  console.log('\nMinting TestERC20 tokens...');
  for (const address of addressesToMint) {
    console.log(`  Minting ${ethers.utils.formatEther(mintAmount)} tokens to ${address}...`);
    const mintTx = await testERC20.mint(address, mintAmount);
    await mintTx.wait();
    const balance = await testERC20.balanceOf(address);
    console.log(`  ✅ Balance: ${ethers.utils.formatEther(balance)} tokens`);
  }

  const testERC721 = await TestERC721.deploy();
  await logVerify('Test ERC721', testERC721, []);

  // Deploy MPKRegistry
  console.log('\nDeploying MPKRegistry...');
  const mpkRegistry = await MPKRegistry.deploy();
  await logVerify('MPKRegistry', mpkRegistry, []);

  const deployConfig = {
    delegator: delegator.address,
    governorRewardsImplementation: '',
    governorRewardsProxy: '',
    implementation: implementation.address,
    proxy: proxy.address,
    proxyAdmin: proxyAdmin.address,
    rail: rail.address,
    staking: staking.address,
    testERC20: testERC20.address,
    testERC721: testERC721.address,
    treasuryImplementation: treasuryImplementation.address,
    treasuryProxy: treasuryProxy.address,
    voting: voting.address,
    weth9: weth9.address,
    relayAdapt: relayAdapt.address,
    poseidonT3: poseidonT3.address,
    poseidonT4: poseidonT4.address,
    mpkRegistry: mpkRegistry.address,
  };

  console.log('\nDEPLOY CONFIG:');
  console.log(deployConfig);

  // Write to JSON file
  const configPath = path.join(__dirname, '../../deployments.json');
  fs.writeFileSync(configPath, JSON.stringify(deployConfig, null, 2));
  console.log(`\n✅ Deployment config saved to: ${configPath}`);

  // Copy deployments.json to demo-ui directory for frontend access
  const demoUiConfigPath = path.join(__dirname, '../../demo-ui/deployments.json');
  fs.copyFileSync(configPath, demoUiConfigPath);
  console.log(`✅ Deployment config copied to: ${demoUiConfigPath}`);
});
