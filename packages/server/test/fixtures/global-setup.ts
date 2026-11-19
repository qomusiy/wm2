import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Media tests need the generated test videos (not stored in git): make any that are missing, once, up front. */
export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  execFileSync('node', [join(here, 'generate.mjs'), join(here, 'media')], { stdio: 'inherit' });
}
