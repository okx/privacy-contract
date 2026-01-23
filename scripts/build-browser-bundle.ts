import * as fs from 'fs';
import * as path from 'path';
import { build, type PluginBuild } from 'esbuild';
// @ts-ignore - CommonJS module without type definitions
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';

/**
 * Build browser bundle for Railgun wallet logic
 * Bundles helpers/browser-logic/*.ts and dependencies into a browser-compatible JS file
 * Uses browser-compatible versions that already have crypto replaced
 */
async function main() {
  console.log('📦 Building browser bundle for Railgun wallet...');

  // Create entry point that exports what we need
  const entryPoint = path.join(__dirname, '../helpers/browser/bundle-entry.ts');
  const outputPath = path.join(__dirname, '../demo-ui/railgun-wallet-bundle.js');

  // Create entry point file if it doesn't exist
  if (!fs.existsSync(entryPoint)) {
    const entryContent = `
// Browser bundle entry point
// This file re-exports the necessary modules for browser use

// Use browser-logic versions (already have crypto replaced)
export * from '../browser-logic/note';
export * from '../browser-logic/wallet';
export * from '../browser-logic/merkletree';
export * from '../global/bytes';
export * from '../global/constants';
`;
    fs.writeFileSync(entryPoint, entryContent);
  }

  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      outfile: outputPath,
      format: 'iife',
      globalName: 'RailgunWallet',
      platform: 'browser',
      target: 'es2020',
      define: {
        'process.env.NODE_ENV': '"production"',
        'global': 'globalThis',
      },
      inject: [],
      banner: {
        js: `
// Polyfills for browser environment
if (typeof global === 'undefined') {
  var global = globalThis;
}
// Note: Buffer polyfill is provided by nodeModulesPolyfillPlugin
// No need for manual Buffer implementation here
`,
      },
      // External dependencies that should not be bundled (available in browser via CDN or already included)
      external: [
        '../../typechain-types',
        '../../typechain-types/contracts/logic/RailgunLogic',
      ],
      // Keep names for better debugging
      minify: false,
      sourcemap: true,
      // Resolve node modules
      resolveExtensions: ['.ts', '.js'],
      // Handle Node.js-specific imports using official polyfill plugin
      plugins: [
        // Use official plugin for Node.js polyfills (handles stream, buffer, etc.)
        nodeModulesPolyfillPlugin({
          // Only polyfill what we need
          modules: {
            stream: true,      // Required for blake-hash
            buffer: true,      // Required for various crypto libraries
            assert: true,      // Used by some dependencies
            util: true,        // Used by stream polyfill
            events: true,      // Used by stream polyfill
            // Exclude crypto - we use Web Crypto API via crypto-browser.ts
            crypto: false,
            // Exclude fs, path, os - not needed in browser
            fs: false,
            path: false,
            os: false,
          },
          // Inject Buffer as a global variable (required for blake-hash)
          globals: {
            Buffer: true,
          },
        }),
        // Handle typechain-types as external
        {
          name: 'typechain-external',
          setup(build: PluginBuild) {
            build.onResolve({ filter: /^\.\.\/\.\.\/typechain-types/ }, () => {
              return { external: true };
            });
          },
        },
      ],
    });

    console.log(`✅ Browser bundle built: ${outputPath}`);
    console.log('   You can now use RailgunWallet in your HTML file');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
