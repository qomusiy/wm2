// Downloads the sticker pack (Microsoft Fluent Emoji 3D, MIT licence) and converts it to small WebP files.
// Usage: node scripts/fetch-stickers.mjs <download-dir>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const downloadDir = process.argv[2];
if (!downloadDir) throw new Error('usage: fetch-stickers.mjs <download-dir>');
const outDir = new URL('../apps/web/public/stickers/', import.meta.url).pathname;
mkdirSync(downloadDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// sticker id -> Fluent folder (and whether it has skin-tone variants, stored under Default/)
const MAP = {
  popcorn: 'Popcorn', 'tears-of-joy': 'Face with tears of joy', rofl: 'Rolling on the floor laughing',
  'heart-eyes': 'Smiling face with heart-eyes', 'star-struck': 'Star-struck', screaming: 'Face screaming in fear',
  'loudly-crying': 'Loudly crying face', crying: 'Crying face', thinking: 'Thinking face', 'open-mouth': 'Face with open mouth',
  astonished: 'Astonished face', 'exploding-head': 'Exploding head', sleeping: 'Sleeping face', yawning: 'Yawning face',
  pleading: 'Pleading face', smirking: 'Smirking face', 'rolling-eyes': 'Face with rolling eyes', zany: 'Zany face',
  partying: 'Partying face', sunglasses: 'Smiling face with sunglasses', skull: 'Skull', ghost: 'Ghost', clown: 'Clown face',
  pouting: ['Pouting face', 'Enraged face'], 'hand-over-mouth': 'Face with hand over mouth', grimacing: 'Grimacing face',
  nauseated: 'Nauseated face', hugging: 'Hugging face', 'red-heart': 'Red heart', 'broken-heart': 'Broken heart', fire: 'Fire',
  hundred: 'Hundred points', 'party-popper': 'Party popper', 'clapper-board': 'Clapper board', 'film-projector': 'Film projector',
  eyes: 'Eyes', 'thumbs-up': 'Thumbs up', clapping: 'Clapping hands', waving: 'Waving hand', 'folded-hands': 'Folded hands',
  sparkles: 'Sparkles', collision: 'Collision', trophy: 'Trophy', crown: 'Crown', rocket: 'Rocket', pizza: 'Pizza',
  'hot-beverage': 'Hot beverage', 'soft-ice-cream': 'Soft ice cream',
};
const BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets';

async function fetchPng(folder) {
  const file = folder.toLowerCase().replace(/ /g, '_');
  const candidates = [
    `${BASE}/${encodeURIComponent(folder)}/3D/${file}_3d.png`,
    `${BASE}/${encodeURIComponent(folder)}/Default/3D/${file}_3d_default.png`,
  ];
  for (const url of candidates) {
    const res = await fetch(url, { headers: { 'User-Agent': 'watchroom-build' } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

const missing = [];
for (const [id, folders] of Object.entries(MAP)) {
  const target = join(outDir, `${id}.webp`);
  if (existsSync(target)) continue;
  let png = null;
  for (const folder of [folders].flat()) {
    png = await fetchPng(folder);
    if (png) break;
  }
  if (!png || png.readUInt32BE(0) !== 0x89504e47) { missing.push(id); continue; }
  const src = join(downloadDir, `${id}.png`);
  writeFileSync(src, png);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=160:160:flags=lanczos', '-c:v', 'libwebp', '-quality', '82',
    '-pix_fmt', 'yuva420p', '-frames:v', '1', target]);
  process.stdout.write('.');
}
writeFileSync(join(outDir, 'LICENSE.txt'), `Stickers: Fluent Emoji by Microsoft (https://github.com/microsoft/fluentui-emoji).

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
console.log(`\nstickers done; missing: ${missing.length ? missing.join(', ') : 'none'}`);
if (missing.length) process.exitCode = 1;
