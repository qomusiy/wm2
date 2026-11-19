import { existsSync } from 'node:fs';

/** Run background work (subtitle extraction, thumbnails) at low CPU priority so playback encoding wins. */
export function lowPriority(cmd: string, args: string[]): [string, string[]] {
  if (process.platform === 'linux' && existsSync('/usr/bin/nice')) return ['/usr/bin/nice', ['-n', '12', cmd, ...args]];
  return [cmd, args];
}
