import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostStore, recentId } from '../src/library';
import { createLogger } from '../src/util/log';

const log = createLogger('test');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wr-store-'));
  const video = (name: string, bytes = 1000) => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  return { dir, video, store: () => new HostStore(join(dir, 'data'), log) };
}

describe('HostStore', () => {
  it('remembers where a video was left and resumes it, but not near the start or the end', () => {
    const { video, store } = setup();
    const movie = video('Movie.mkv');
    const s = store();
    let r = s.opened(movie, { title: 'Movie', duration: 3600 });
    expect(r.resumeAt).toBe(0);
    s.progress(r.entry.id, 1234.5, true);
    r = store().opened(movie, { title: 'Movie', duration: 3600 }); // a fresh instance reads the file
    expect(r.resumeAt).toBeCloseTo(1234.5);

    const s2 = store();
    s2.progress(r.entry.id, 12, true); // too close to the start
    expect(s2.opened(movie, { title: 'Movie', duration: 3600 }).resumeAt).toBe(0);
    s2.progress(r.entry.id, 3560, true); // credits: counts as finished
    const e = s2.get(r.entry.id)!;
    expect(e).toMatchObject({ finished: true, position: 0 });
    expect(s2.opened(movie, { title: 'Movie', duration: 3600 }).resumeAt).toBe(0);
  });

  it('forgets the position when the file changed on disk', () => {
    const { video, store } = setup();
    const movie = video('Movie.mkv');
    const s = store();
    const { entry } = s.opened(movie, { title: 'Movie', duration: 3600 });
    s.progress(entry.id, 900, true);
    writeFileSync(movie, Buffer.alloc(2000));
    utimesSync(movie, new Date(), new Date(Date.now() + 5000));
    expect(s.opened(movie, { title: 'Movie', duration: 3600 }).resumeAt).toBe(0);
  });

  it('keeps the newest twelve, most recent first, and deletes posters of dropped videos', () => {
    const { video, store, dir } = setup();
    const s = store();
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const p = video(`v${i}.mp4`);
      ids.push(s.opened(p, { title: `v${i}`, duration: 100 }).entry.id);
      if (i === 0) {
        const poster = s.posterPath(ids[0]!);
        mkdirSync(join(dir, 'data', 'posters'), { recursive: true });
        writeFileSync(poster, 'jpg');
      }
    }
    const list = s.recent();
    expect(list).toHaveLength(12);
    expect(list[0]!.title).toBe('v12');
    expect(list.some((e) => e.id === ids[0])).toBe(false);
    expect(existsSync(s.posterPath(ids[0]!))).toBe(false);
  });

  it('marks missing files and removes entries on request', async () => {
    const { video, store } = setup();
    const a = video('a.mkv');
    const b = video('b.mkv');
    const s = store();
    s.opened(a, { title: 'A', duration: 100 });
    const { entry } = s.opened(b, { title: 'B', duration: 100 });
    rmSync(a);
    const list = await s.describe(entry.id);
    expect(list.map((v) => [v.title, v.missing, v.current])).toEqual([['B', false, true], ['A', true, false]]);
    expect(list[0]).toMatchObject({ fileName: 'b.mkv', poster: null });
    s.remove(recentId(a));
    expect(s.recent().map((e) => e.title)).toEqual(['B']);
    s.remove(null);
    expect(store().recent()).toEqual([]);
  });

  it('survives a corrupted or hand-edited settings file and keeps link and room preferences', () => {
    const { dir, store } = setup();
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'settings.json'), '{ not json');
    expect(store().recent()).toEqual([]);
    writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({
      linkMode: 'lan', customBase: 5, room: { controlMode: 'host', bufferingPolicy: 'bogus', maxParticipants: 999 },
      recent: [{ id: 'nope', path: '/etc/passwd' }, null, 'x'],
    }));
    const s = store();
    expect(s.linkMode).toBe('lan');
    expect(s.customBase).toBeNull();
    expect(s.roomDefaults).toEqual({ controlMode: 'host' });
    expect(s.recent()).toEqual([]);
    s.setRoomDefaults({ controlMode: 'everyone', bufferingPolicy: 'continue', maxParticipants: 4, p2p: false });
    s.save(true);
    const saved = JSON.parse(readFileSync(join(dir, 'data', 'settings.json'), 'utf8'));
    expect(saved.room).toEqual({ controlMode: 'everyone', bufferingPolicy: 'continue', maxParticipants: 4, p2p: false });
  });
});
