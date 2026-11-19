// Pre-compress built assets (served with @fastify/static preCompressed). The host's upload is the bottleneck,
// and the tunnel forwards bytes uncompressed from this computer to Cloudflare.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const root = new URL('./dist/', import.meta.url).pathname;
let saved = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html|svg|json)$/.test(name)) {
      const buf = readFileSync(p);
      if (buf.length < 1024) continue;
      const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      writeFileSync(`${p}.br`, br);
      writeFileSync(`${p}.gz`, gzipSync(buf, { level: 9 }));
      saved += buf.length - br.length;
    }
  }
};
walk(root);
console.log(`precompressed assets (saves ${(saved / 1024).toFixed(0)} KB per visitor with brotli)`);
