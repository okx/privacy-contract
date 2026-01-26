import { ethers } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import { arrayToBigInt, arrayToHexString } from '../../helpers/global/bytes';
import { hash } from '../../helpers/global/crypto';
import { MerkleTree } from '../../helpers/logic/merkletree';
import { randomBytes } from 'crypto';

describe('Logic/Commitments', () => {
  /**
   * Deploy fixtures
   *
   * @returns fixtures
   */
  async function deploy() {
    const PoseidonT3 = await ethers.getContractFactory('PoseidonT3');
    const poseidonT3 = await PoseidonT3.deploy();

    const CommitmentsStub = await ethers.getContractFactory('CommitmentsStub', {
      libraries: {
        PoseidonT3: poseidonT3.address,
      },
    });
    const commitments = await CommitmentsStub.deploy();

    return {
      commitments,
    };
  }

  it("Shouldn't initialize twice", async () => {
    const { commitments } = await loadFixture(deploy);

    await expect(commitments.doubleInit()).to.be.revertedWith(
      'Initializable: contract is not initializing',
    );
  });

  it('Should calculate zero values', async () => {
    const { commitments } = await loadFixture(deploy);

    const merkletree = await MerkleTree.createTree();

    // Each value in the zero values array should be the same
    await Promise.all(
      merkletree.zeros.map(async (zeroValue, level) => {
        expect(await commitments.zeros(level)).to.equal(arrayToBigInt(zeroValue));
      }),
    );

    // Zero value should be the same
    expect(await commitments.ZERO_VALUE()).to.equal(arrayToBigInt(MerkleTree.zeroValue));
  });

  it('Should calculate empty root', async () => {
    const { commitments } = await loadFixture(deploy);

    const merkletree = await MerkleTree.createTree();

    // Should initialize empty root correctly
    expect(await commitments.merkleRoot()).to.equal(arrayToBigInt(merkletree.root));
  });

  it('Should hash left/right pairs', async () => {
    const loops = process.env.SKIP_LONG_TESTS ? 2 : 10;

    const { commitments } = await loadFixture(deploy);

    for (let i = 0; i < loops; i += 1) {
      // Create left/right test values
      const left = await hash.poseidon([new Uint8Array([i])]);
      const right = await hash.poseidon([new Uint8Array([i]), new Uint8Array([1])]);

      // Get expected result
      const result = await hash.poseidon([left, right]);

      // Check if hash function on contract returns same value
      expect(await commitments.hashLeftRight(left, right)).to.equal(arrayToBigInt(result));
    }
  });

  it('Should incrementally insert elements', async function () {
    const loops = process.env.SKIP_LONG_TESTS ? 2 : 10;

    const { commitments } = await loadFixture(deploy);

    const merkletree = await MerkleTree.createTree();

    const insertList = [];
    for (let i = 0; i < loops; i += 1) {
      // Check the insertion numbers
      expect(
        await commitments.getStartingIndex(insertList.length),
      ).to.equal(merkletree.length);

      // Update with insert list on local and contract
      await commitments.insertLeavesStub(insertList);
      await merkletree.insertLeaves(insertList, merkletree.length);

      // Check roots match
      expect(await commitments.merkleRoot()).to.equal(arrayToHexString(merkletree.root, true));

      // Check tree length matches
      expect(await commitments.nextLeafIndex()).to.equal(merkletree.length);

      // Add another element to insert list
      insertList.push(randomBytes(32));
    }
  });

  it('Should handle tree capacity', async function () {
    const { commitments } = await loadFixture(deploy);

    // Set next leaf index to one less than filled tree 16 levels = 2^16 capacity)
    await commitments.setNextLeafIndex(2 ** 16 - 2);

    // Check the insertion starting index
    expect(await commitments.getStartingIndex(1)).to.equal(2 ** 16 - 2);

    // Insert leaf hash
    await commitments.insertLeavesStub([randomBytes(32)]);

    // Check the insertion starting index
    expect(await commitments.getStartingIndex(1)).to.equal(2 ** 16 - 1);

    // Insert leaf hash (tree is now full, nextLeafIndex = 2^16)
    await commitments.insertLeavesStub([randomBytes(32)]);

    // Try to insert beyond capacity (should revert)
    await expect(commitments.insertLeavesStub([randomBytes(32)])).to.be.revertedWith(
      'Commitments: Tree capacity exceeded',
    );
  });
});
