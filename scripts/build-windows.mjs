#!/usr/bin/env node
/*
 * Builds the Windows installer (release/Watchroom-Setup-<version>.exe) on Linux.
 *
 * Downloads (resumable, cached in .build-cache/windows) and verifies by SHA-256:
 *   - Electron for Windows (checked against Electron's published SHASUMS256.txt),
 *   - ffmpeg/ffprobe for Windows (gyan.dev "essentials" release build, GPL, includes libx264),
 *   - cloudflared for Windows (Cloudflare's release checksum),
 *   - the Windows build of the WebRTC library (npm verifies the registry's integrity hash).
 * Then builds the app and runs electron-builder for Windows (NSIS), without Wine.
 *
 *   node scripts/build-windows.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cache = join(root, '.build-cache', 'windows');
const stage = join(cache, 'stage');
const ELECTRON = '45.2.3';
const FFMPEG = '9.0.2';
const CLOUDFLARED = '2026.10.7';
const NDC = '0.33.4';

const inputs = {
  electron: {
    file: `electron-v${ELECTRON}-win32-x64.zip`,
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON}/electron-v${ELECTRON}-win32-x64.zip`,
    // Verified against SHASUMS256.txt from the same release (downloaded below).
    sha256: null,
  },
  electronSums: {
    file: 'electron-SHASUMS256.txt',
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON}/SHASUMS256.txt`,
    sha256: null,
  },
  ffmpeg: {
    file: `ffmpeg-${FFMPEG}-essentials_build.7z`,
    url: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG}/ffmpeg-${FFMPEG}-essentials_build.7z`,
    sha256: '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077',
  },
  cloudflared: {
    file: 'cloudflared-windows-amd64.exe',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED}/cloudflared-windows-amd64.exe`,
    sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
  },
};
const NDC_NODE_SHA256 = '414a538f72ee7bcae8af61a875d994b0af98610e360fedd7e3548fd77d33e09a';

const step = (msg) => console.log(`\n▸ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function sha256(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

function download(file, url) {
  const dest = join(cache, file);
  console.log(`  downloading ${file} (resumable)…`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    // A connection that hangs (no data for 60 s) is dropped and the download resumes where it stopped.
    const r = spawnSync('curl', ['-fL', '--retry', '5', '--retry-delay', '3', '--speed-limit', '1024', '--speed-time', '60', '-C', '-', '-o', dest, url], { stdio: 'inherit' });
    if (r.status === 0) return dest;
    // 33 = range not satisfiable (already complete): accept and let the checksum decide.
    if (r.status === 33) return dest;
    console.log(`  retrying (${attempt})…`);
  }
  fail(`could not download ${url}`);
}

async function fetchVerified(key) {
  const inp = inputs[key];
  const path = join(cache, inp.file);
  if (!existsSync(path)) download(inp.file, inp.url);
  let expected = inp.sha256;
  if (key === 'electron') {
    const sums = readFileSync(join(cache, inputs.electronSums.file), 'utf8');
    expected = new RegExp(`^([0-9a-f]{64}) \\*?${inp.file.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1] ?? null;
    if (!expected) fail(`no checksum for ${inp.file} in SHASUMS256.txt`);
  }
  if (expected) {
    let actual = await sha256(path);
    if (actual !== expected) {
      // An interrupted earlier download: resume once more, then check again.
      download(inp.file, inp.url);
      actual = await sha256(path);
    }
    if (actual !== expected) {
      rmSync(path, { force: true });
      fail(`${inp.file}: checksum mismatch (expected ${expected}, got ${actual}); deleted, run again`);
    }
    console.log(`  ✓ ${inp.file} (sha256 ${expected.slice(0, 16)}…)`);
  }
  return path;
}

function sevenZip() {
  const base = join(homedir(), '.cache', 'electron-builder');
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4 || !existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p, depth + 1);
      else if (n.name === '7zz' || n.name === '7za') found.push(p);
    }
  };
  walk(base, 0);
  const system = ['7zz', '7z', '7za'].find((c) => spawnSync('which', [c]).status === 0);
  return found[0] ?? system ?? fail('no 7-Zip found (run `npm run package` once, or install p7zip)');
}

mkdirSync(cache, { recursive: true });

step('Downloading and verifying Windows build inputs');
await fetchVerified('electronSums');
const electronZip = await fetchVerified('electron');
const ffmpeg7z = await fetchVerified('ffmpeg');
const cloudflaredExe = await fetchVerified('cloudflared');

const ndcDir = join(cache, 'ndc-win', 'package');
if (!existsSync(join(ndcDir, 'node_datachannel.node'))) {
  execFileSync('npm', ['pack', `@node-datachannel/win32-x64-msvc@${NDC}`, '--silent'], { cwd: cache, stdio: 'inherit' });
  mkdirSync(join(cache, 'ndc-win'), { recursive: true });
  execFileSync('tar', ['-xzf', join(cache, `node-datachannel-win32-x64-msvc-${NDC}.tgz`), '-C', join(cache, 'ndc-win')]);
}
if ((await sha256(join(ndcDir, 'node_datachannel.node'))) !== NDC_NODE_SHA256) fail('WebRTC library for Windows: checksum mismatch');
console.log('  ✓ node_datachannel.node (Windows)');

step('Unpacking');
const electronDir = join(cache, `electron-v${ELECTRON}-win32-x64`);
if (!existsSync(join(electronDir, 'electron.exe'))) {
  rmSync(electronDir, { recursive: true, force: true });
  execFileSync('unzip', ['-q', electronZip, '-d', electronDir]);
}
if (!existsSync(join(electronDir, 'electron.exe'))) fail('Electron for Windows did not unpack');
console.log(`  ✓ Electron ${ELECTRON} for Windows`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'ffmpeg'), { recursive: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
const ffx = join(cache, 'ffmpeg-extract');
rmSync(ffx, { recursive: true, force: true });
execFileSync(sevenZip(), ['x', '-y', `-o${ffx}`, ffmpeg7z], { stdio: 'ignore' });
const ffRoot = join(ffx, readdirSync(ffx).find((n) => n.startsWith('ffmpeg-')) ?? fail('unexpected ffmpeg archive layout'));
for (const f of ['ffmpeg.exe', 'ffprobe.exe']) copyFileSync(join(ffRoot, 'bin', f), join(stage, 'ffmpeg', f));
copyFileSync(join(ffRoot, 'LICENSE'), join(stage, 'ffmpeg', 'LICENSE.txt'));
writeFileSync(join(stage, 'ffmpeg', 'README.txt'), [
  `FFmpeg ${FFMPEG} for Windows, "essentials" build by Gyan Doshi (https://www.gyan.dev/ffmpeg/builds/),`,
  `from https://github.com/GyanD/codexffmpeg/releases/tag/${FFMPEG} (sha256 of the archive: ${inputs.ffmpeg.sha256}).`,
  'Licensed under the GNU GPL v3 (see LICENSE.txt). Source code: https://ffmpeg.org/download.html and the build',
  'scripts and library sources listed on gyan.dev. Watchroom runs these programs as separate processes.',
  '',
].join('\r\n'));
rmSync(ffx, { recursive: true, force: true });
copyFileSync(cloudflaredExe, join(stage, 'bin', 'cloudflared.exe'));
writeFileSync(join(stage, 'bin', 'README.txt'), [
  `cloudflared ${CLOUDFLARED} for Windows by Cloudflare (https://github.com/cloudflare/cloudflared),`,
  `Apache License 2.0. sha256: ${inputs.cloudflared.sha256}. Used for the "Internet" sharing link.`,
  '',
].join('\r\n'));
for (const f of ['ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'bin/cloudflared.exe']) {
  console.log(`  ✓ ${f} (${(statSync(join(stage, f)).size / 1e6).toFixed(1)} MB)`);
}

step('Building the app');
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

step('Packaging for Windows (NSIS installer)');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_')));
// Through a small wrapper that makes the uninstaller without Wine (see scripts/electron-builder-no-wine.cjs).
const eb = spawnSync('node', ['scripts/electron-builder-no-wine.cjs', '--projectDir', 'apps/desktop', '--win', '--x64', `-c.electronDist=${electronDir}`], {
  cwd: root, stdio: 'inherit', env,
});
if (eb.status !== 0) fail('electron-builder failed');

const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const setup = join(root, 'release', `Watchroom-Setup-${version}.exe`);
if (!existsSync(setup)) fail(`installer not found at ${setup}`);
console.log(`\n✓ ${setup}\n  ${(statSync(setup).size / 1e6).toFixed(1)} MB, sha256 ${await sha256(setup)}`);

step('Making the package to send (installer + instructions)');
// Instructions as Windows text files: CRLF line endings and a UTF-8 byte-order mark, so every Notepad version
// (including old Windows 10 ones) shows the Russian text correctly. File names stay ASCII for the same reason.
const bundle = join(root, 'release', `Watchroom-for-Windows-${version}`);
rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });
copyFileSync(setup, join(bundle, `Watchroom-Setup-${version}.exe`));
const guides = join(root, 'packaging', 'windows');
for (const name of readdirSync(guides).filter((n) => n.endsWith('.txt'))) {
  const text = readFileSync(join(guides, name), 'utf8').replace(/\r?\n/g, '\r\n');
  writeFileSync(join(bundle, name), `\uFEFF${text}`, 'utf8');
}
const zipPath = `${bundle}.zip`;
rmSync(zipPath, { force: true });
execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: bundle });
console.log(`✓ ${zipPath}\n  ${(statSync(zipPath).size / 1e6).toFixed(1)} MB, sha256 ${await sha256(zipPath)}`);
