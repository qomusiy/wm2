import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  legalComments: 'none',
  // Native WebRTC bindings stay outside the bundle and are loaded from node_modules at runtime.
  external: ['node-datachannel'],
  define: { 'import.meta.url': 'undefined' },
};

await Promise.all([
  build({ ...common, entryPoints: [here('./src/cli.ts')], outfile: here('./dist/cli.cjs') }),
  build({ ...common, entryPoints: [here('./src/utility.ts')], outfile: here('./dist/utility.cjs') }),
]);
console.log('server built');
