import { task } from 'hardhat/config';
import * as fs from 'fs';
import * as path from 'path';

import * as weth9artifact from '../../externalArtifacts/WETH9.json';

import { getKeys } from '../../helpers/logic/artifacts';
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

  // Get starting nonce for batch deployment
  let nonce = await deployer.getTransactionCount('pending');
  
  // Deploy Poseidon libraries in parallel
  console.log('\nDeploying Poseidon libraries...');
  const poseidonT3 = await PoseidonT3.deploy({ nonce: nonce++ });
  const poseidonT4 = await PoseidonT4.deploy({ nonce: nonce++ });
  
  // Wait for both in parallel
  await Promise.all([
    poseidonT3.deployTransaction.wait().then(() => console.log('✅ PoseidonT3 deployed:', poseidonT3.address)),
    poseidonT4.deployTransaction.wait().then(() => console.log('✅ PoseidonT4 deployed:', poseidonT4.address)),
  ]);

  // Get Railgun Smart Wallet
  const RailgunSmartWallet = await ethers.getContractFactory('RailgunSmartWalletStub', {
    signer: deployer,
    libraries: {
      PoseidonT3: poseidonT3.address,
      PoseidonT4: poseidonT4.address,
    },
  });

  // Deploy independent contracts in parallel
  console.log('\nDeploying core contracts...');
  const rail = await RailToken.deploy('RailTest', 'RAILTEST', { nonce: nonce++ });
  const treasuryImplementation = await TreasuryImplementation.deploy({ nonce: nonce++ });
  const implementation = await RailgunSmartWallet.deploy({ nonce: nonce++ });
  
  // Wait for independent deploys
  await Promise.all([
    rail.deployTransaction.wait().then(() => console.log('✅ RailToken deployed:', rail.address)),
    treasuryImplementation.deployTransaction.wait().then(() => console.log('✅ Treasury Implementation deployed:', treasuryImplementation.address)),
    implementation.deployTransaction.wait().then(() => console.log('✅ Implementation deployed:', implementation.address)),
  ]);
  
  // Mint tokens to deployer
  const mintTx = await rail.adminMint(deployer.address, 50000000n * 10n ** 18n, { nonce: nonce++ });
  
  // Deploy contracts that depend on rail
  console.log('\nDeploying dependent contracts...');
  const staking = await Staking.deploy(rail.address, { nonce: nonce++ });
  const delegator = await Delegator.deploy(deployer.address, { nonce: nonce++ });
  
  await Promise.all([
    mintTx.wait().then(() => console.log('✅ Minted tokens to deployer')),
    staking.deployTransaction.wait().then(() => console.log('✅ Staking deployed:', staking.address)),
    delegator.deployTransaction.wait().then(() => console.log('✅ Delegator deployed:', delegator.address)),
  ]);
  
  // Deploy contracts that depend on staking/delegator
  const voting = await Voting.deploy(staking.address, delegator.address, { nonce: nonce++ });
  const proxyAdmin = await ProxyAdmin.deploy(deployer.address, { nonce: nonce++ });
  
  await Promise.all([
    voting.deployTransaction.wait().then(() => console.log('✅ Voting deployed:', voting.address)),
    proxyAdmin.deployTransaction.wait().then(() => console.log('✅ ProxyAdmin deployed:', proxyAdmin.address)),
  ]);
  
  // Deploy proxies
  console.log('\nDeploying proxies...');
  const treasuryProxy = await Proxy.deploy(proxyAdmin.address, { nonce: nonce++ });
  const proxy = await Proxy.deploy(proxyAdmin.address, { nonce: nonce++ });
  
  await Promise.all([
    treasuryProxy.deployTransaction.wait().then(() => console.log('✅ Treasury Proxy deployed:', treasuryProxy.address)),
    proxy.deployTransaction.wait().then(() => console.log('✅ Proxy deployed:', proxy.address)),
  ]);

  // Set implementation for proxies (batch send)
  console.log('\nSetting proxy implementations');
  const upgradeTx1 = await proxyAdmin.upgrade(proxy.address, implementation.address, { nonce: nonce++ });
  const unpauseTx1 = await proxyAdmin.unpause(proxy.address, { nonce: nonce++ });
  const upgradeTx2 = await proxyAdmin.upgrade(treasuryProxy.address, treasuryImplementation.address, { nonce: nonce++ });
  const unpauseTx2 = await proxyAdmin.unpause(treasuryProxy.address, { nonce: nonce++ });
  
  await Promise.all([
    upgradeTx1.wait().then(() => console.log('✅ Proxy upgraded')),
    unpauseTx1.wait().then(() => console.log('✅ Proxy unpaused')),
    upgradeTx2.wait().then(() => console.log('✅ Treasury proxy upgraded')),
    unpauseTx2.wait().then(() => console.log('✅ Treasury proxy unpaused')),
  ]);

  // Get proxied contracts
  const treasury = TreasuryImplementation.attach(treasuryProxy.address);
  const railgun = RailgunSmartWallet.attach(proxy.address);

  // Initialize contracts (batch send)
  console.log('\nInitializing contracts');
  const initTreasuryTx = await treasury.initializeTreasury(delegator.address, { nonce: nonce++ });
  const initRailgunTx = await railgun.initializeRailgunLogic(
    treasuryProxy.address,
    0n,
    0n,
    0n,
    deployer.address,
    { gasLimit: 2000000, nonce: nonce++ },
  );
  
  await Promise.all([
    initTreasuryTx.wait().then(() => console.log('✅ Treasury initialized')),
    initRailgunTx.wait().then(() => console.log('✅ Railgun initialized')),
  ]);

  // Set artifacts (batch send all verification keys)
  console.log('\nSetting Artifacts');
  
  // Custom circuit list: inputs 1-10, outputs 1 or 2 (20 circuits total)
  const customCircuits: Array<{ nullifiers: number; commitments: number }> = [];
  for (let nullifiers = 1; nullifiers <= 10; nullifiers++) {
    for (let commitments = 1; commitments <= 2; commitments++) {
      customCircuits.push({ nullifiers, commitments });
    }
  }
  
  console.log(`Loading ${customCircuits.length} circuits (inputs: 1-10, outputs: 1-2)...`);
  
  // Batch send all setVerificationKey transactions
  const vkeyTxs = [];
  for (const artifactConfig of customCircuits) {
    const artifact = getKeys(artifactConfig.nullifiers, artifactConfig.commitments);
    console.log(`  Queuing circuit ${artifactConfig.nullifiers}x${artifactConfig.commitments}...`);
    vkeyTxs.push(
      await railgun.setVerificationKey(
        artifactConfig.nullifiers,
        artifactConfig.commitments,
        artifact.solidityVKey,
        { nonce: nonce++ }
      )
    );
  }
  
  // Wait for all verification keys to be set
  await Promise.all(
    vkeyTxs.map((tx, i) => 
      tx.wait().then(() => {
        const config = customCircuits[i];
        console.log(`  ✅ Circuit ${config.nullifiers}x${config.commitments} loaded`);
      })
    )
  );
  console.log('✅ All circuits loaded');

  // Give deployer address full permissions
  console.log(`\nGiving full governance permissions to ${deployer.address}`);
  const setPermTx = await delegator.setPermission(
    deployer.address,
    ethers.constants.AddressZero,
    '0x00000000',
    true,
    { nonce: nonce++ }
  );
  await setPermTx.wait();
  console.log('✅ Permissions set');

  // Transfer contract ownerships (batch send)
  console.log('\nTransferring ownerships');
  const transferTx1 = await railgun.transferOwnership(delegator.address, { nonce: nonce++ });
  const transferTx2 = await proxyAdmin.transferOwnership(delegator.address, { nonce: nonce++ });
  const transferTx3 = await delegator.transferOwnership(voting.address, { nonce: nonce++ });
  
  await Promise.all([
    transferTx1.wait().then(() => console.log('✅ Railgun ownership transferred')),
    transferTx2.wait().then(() => console.log('✅ ProxyAdmin ownership transferred')),
    transferTx3.wait().then(() => console.log('✅ Delegator ownership transferred')),
  ]);

  // Deploy WETH9 and test tokens (batch send)
  console.log('\nDeploying WETH9 and test tokens...');
  const WETH9 = new ethers.ContractFactory(
    weth9artifact.abi,
    weth9artifact.bytecode,
    deployer,
  );
  const weth9 = await WETH9.deploy({ nonce: nonce++ });
  const testERC20 = await TestERC20.deploy({ nonce: nonce++ });
  const testERC721 = await TestERC721.deploy({ nonce: nonce++ });
  
  await Promise.all([
    weth9.deployTransaction.wait().then(() => console.log('✅ WETH9 deployed:', weth9.address)),
    testERC20.deployTransaction.wait().then(() => console.log('✅ Test ERC20 deployed:', testERC20.address)),
    testERC721.deployTransaction.wait().then(() => console.log('✅ Test ERC721 deployed:', testERC721.address)),
  ]);

  // Deploy RelayAdapt (depends on weth9)
  const relayAdapt = await RelayAdapt.deploy(proxy.address, weth9.address, { nonce: nonce++ });
  const mpkRegistry = await MPKRegistry.deploy({ nonce: nonce++ });
  
  await Promise.all([
    relayAdapt.deployTransaction.wait().then(() => console.log('✅ RelayAdapt deployed:', relayAdapt.address)),
    mpkRegistry.deployTransaction.wait().then(() => console.log('✅ MPKRegistry deployed:', mpkRegistry.address)),
  ]);

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

  // Batch mint tokens to all addresses
  console.log('\nMinting TestERC20 tokens...');
  const mintTxs = [];
  for (const address of addressesToMint) {
    console.log(`  Queuing mint ${ethers.utils.formatEther(mintAmount)} tokens to ${address}...`);
    mintTxs.push(await testERC20.mint(address, mintAmount, { nonce: nonce++ }));
  }
  
  // Wait for all mints in parallel
  await Promise.all(
    mintTxs.map((tx, i) => 
      tx.wait().then(() => console.log(`  ✅ Minted to ${addressesToMint[i]}`))
    )
  );
  
  // Verify balances
  console.log('\nVerifying balances...');
  for (const address of addressesToMint) {
    const balance = await testERC20.balanceOf(address);
    console.log(`  ✅ ${address}: ${ethers.utils.formatEther(balance)} tokens`);
  }

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
