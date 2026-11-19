import type { FileMediaDescriptor, MediaDescriptor } from '@watchroom/protocol';

/** The descriptor of a video file (tests that stream files expect one). */
export function asFile(m: MediaDescriptor | null | undefined): FileMediaDescriptor {
  if (!m || m.kind !== 'file') throw new Error(`expected a file media descriptor, got ${m ? m.kind : 'none'}`);
  return m;
}
