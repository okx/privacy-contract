import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';

/**
 * Build encryption bundle for browser use
 * Bundles helpers/logic/note.ts and dependencies into a browser-compatible JS file
 */
async function main() {
  console.log('📦 Building encryption bundle for browser...');

  const entryPoint = path.join(__dirname, '../helpers/logic/note.ts');
  const outputPath = path.join(__dirname, '../demo-ui/railgun-encryption.js');

  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      outfile: outputPath,
      format: 'iife',
      globalName: 'RailgunEncryption',
      platform: 'browser',
      target: 'es2020',
      external: ['crypto'], // Web Crypto API is available in browser
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      // Polyfills for Node.js modules used in browser
      inject: [],
      // Keep names for better debugging
      minify: false,
      sourcemap: true,
      // Resolve node modules
      resolveExtensions: ['.ts', '.js'],
      // Handle circomlibjs and other native modules
      plugins: [
        {
          name: 'node-polyfills',
          setup(build) {
            // Replace 'crypto' import with browser-compatible version
            build.onResolve({ filter: /^crypto$/ }, () => {
              return { path: 'crypto', namespace: 'browser-crypto' };
            });
            build.onLoad({ filter: /.*/, namespace: 'browser-crypto' }, () => {
              return {
                contents: `
                  // Browser crypto polyfill
                  export default {
                    randomBytes: (length) => {
                      const array = new Uint8Array(length);
                      crypto.getRandomValues(array);
                      return array;
                    },
                    createCipheriv: (algorithm, key, iv, options) => {
                      // This will be handled by Web Crypto API in the actual implementation
                      throw new Error('Use Web Crypto API instead');
                    },
                    createDecipheriv: (algorithm, key, iv, options) => {
                      throw new Error('Use Web Crypto API instead');
                    }
                  };
                `,
              };
            });
          },
        },
      ],
    });

    console.log(`✅ Encryption bundle built: ${outputPath}`);
    console.log('   You can now use RailgunEncryption in your HTML file');
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
