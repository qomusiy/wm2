#!/usr/bin/env node
/*
 * electron-builder for Windows targets built on Linux, without Wine.
 *
 * electron-builder makes the NSIS uninstaller by building a special installer and *running* it (under Wine off
 * Windows). On macOS it instead extracts the uninstaller from that file with its own pure-JavaScript reader
 * (UninstallerReader in app-builder-lib), because Wine isn't available there. That choice is made by a single
 * isMacOsCatalina() check, used nowhere else (app-builder-lib/out/targets/nsis/NsisTarget.js). Taking the same path
 * here avoids needing a working Wine. Arguments are passed to the normal electron-builder command line.
 */
const macos = require('app-builder-lib/out/util/macosVersion');
macos.isMacOsCatalina = () => true;
require('electron-builder/cli.js');
