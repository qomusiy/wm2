// Starts the Electron host app with a clean environment. Tools such as editors may set ELECTRON_RUN_AS_NODE,
// which would make Electron behave like plain Node and fail to open a window.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const appDir = fileURLToPath(new URL('.', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electron, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
