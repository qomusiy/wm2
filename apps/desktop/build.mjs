import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'], logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: [here('./src/main.ts')], outfile: here('./dist/main.cjs') }),
  build({ ...common, entryPoints: [here('./src/preload.ts')], outfile: here('./dist/preload.cjs') }),
]);
console.log('desktop built');
