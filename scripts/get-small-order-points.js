// Script to demonstrate how to get and check small order points in ed25519
// Small order points are points where h * P = 0 (h = 8 is the cofactor)

const { Point, ExtendedPoint, CURVE } = require('../node_modules/@noble/ed25519/lib/index.js');

console.log('=== Ed25519 Small Order Points ===\n');
console.log('Cofactor h =', CURVE.h.toString());
console.log('Total: 8 small order points (1 of order 1, 2 of order 2, 4 of order 4, 1 of order 8)\n');

// Method 1: Zero point (identity, order 1) - always available
console.log('1. Zero Point (Identity, Order 1):');
const zeroPoint = Point.ZERO;
const zeroExtended = ExtendedPoint.fromAffine(zeroPoint);
console.log(`   Public Key (hex): ${Buffer.from(zeroPoint.toRawBytes()).toString('hex')}`);
console.log(`   X: ${zeroPoint.x.toString()}`);
console.log(`   Y: ${zeroPoint.y.toString()}`);
console.log(`   Is Small Order: ${zeroExtended.isSmallOrder()}`);
console.log(`   Is Torsion Free: ${zeroExtended.isTorsionFree()}`);
console.log('');

// Method 2: How to check if any point is small order
console.log('2. How to Check if a Point is Small Order:');
console.log('   ```javascript');
console.log('   const { Point, ExtendedPoint } = require("@noble/ed25519");');
console.log('   ');
console.log('   // From hex string (compressed point, 32 bytes)');
console.log('   const point = Point.fromHex(hexString, false);');
console.log('   const extPoint = ExtendedPoint.fromAffine(point);');
console.log('   ');
console.log('   // Check if small order');
console.log('   const isSmall = extPoint.isSmallOrder();');
console.log('   ');
console.log('   // Get public key (32 bytes)');
console.log('   const pubKey = point.toRawBytes();');
console.log('   ```');
console.log('');

// Method 3: Known small order points (well-documented in ed25519)
// These are the canonical 8 small order points
console.log('3. Known Small Order Points (for validation):');
console.log('   These are the 8 canonical small order points in ed25519:\n');

const smallOrderPoints = [
  {
    name: 'Zero Point',
    hex: '0100000000000000000000000000000000000000000000000000000000000000',
    order: 1,
    description: 'Identity element'
  },
  {
    name: 'Small Order Point 1',
    hex: 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    order: 2
  },
  {
    name: 'Small Order Point 2',
    hex: '0000000000000000000000000000000000000000000000000000000000000000',
    order: 4
  },
  {
    name: 'Small Order Point 3',
    hex: '0000000000000000000000000000000000000000000000000000000000000080',
    order: 4
  },
  {
    name: 'Small Order Point 4',
    hex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    order: 8
  },
  {
    name: 'Small Order Point 5',
    hex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    order: 8
  },
  {
    name: 'Small Order Point 6',
    hex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    order: 8
  },
  {
    name: 'Small Order Point 7',
    hex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    order: 8
  }
];

smallOrderPoints.forEach(({ name, hex, order, description }) => {
  try {
    // Pad hex to 64 characters if needed
    const paddedHex = hex.length === 64 ? hex : hex.padStart(64, '0');
    const point = Point.fromHex(paddedHex, false);
    const extPoint = ExtendedPoint.fromAffine(point);
    const isSmall = extPoint.isSmallOrder();
    const pubKey = Buffer.from(point.toRawBytes()).toString('hex');
    
    console.log(`   ${name} (Order ${order}):`);
    if (description) console.log(`     Description: ${description}`);
    console.log(`     Hex: ${hex}`);
    console.log(`     Public Key: ${pubKey}`);
    console.log(`     Is Small Order: ${isSmall}`);
    console.log(`     Is Torsion Free: ${extPoint.isTorsionFree()}`);
    console.log('');
  } catch (error) {
    console.log(`   ${name}: Error parsing - ${error.message}`);
    console.log(`     Hex: ${hex}`);
    console.log('');
  }
});

// Method 4: Practical usage example
console.log('4. Practical Usage Example:');
console.log('   To validate a public key and reject small order points:');
console.log('   ```javascript');
console.log('   function validatePublicKey(publicKeyHex) {');
console.log('     const point = Point.fromHex(publicKeyHex, false);');
console.log('     const extPoint = ExtendedPoint.fromAffine(point);');
console.log('     ');
console.log('     if (extPoint.isSmallOrder()) {');
console.log('       throw new Error("Small order point detected - security risk!");');
console.log('     }');
console.log('     ');
console.log('     if (!extPoint.isTorsionFree()) {');
console.log('       throw new Error("Torsion point detected - not safe!");');
console.log('     }');
console.log('     ');
console.log('     return point; // Safe to use');
console.log('   }');
console.log('   ```');
console.log('');

// Summary
console.log('=== Summary ===');
console.log('• Use Point.fromHex() to create a point from hex string');
console.log('• Use ExtendedPoint.fromAffine() to get extended coordinates');
console.log('• Use isSmallOrder() to check if point is small order (should reject)');
console.log('• Use isTorsionFree() to check if point is torsion free (should accept)');
console.log('• Use toRawBytes() to get the 32-byte public key representation');
