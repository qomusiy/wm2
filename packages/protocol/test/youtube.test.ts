import { describe, expect, it } from 'vitest';
import { findYouTubeLink, parseYouTubeTime, parseYouTubeUrl } from '../src';

describe('YouTube links', () => {
  it('reads every common link form', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&list=PL123&index=2`,
      `http://m.youtube.com/watch?feature=share&v=${id}`,
      `www.youtube.com/watch?v=${id}`,
      `youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `youtu.be/${id}?si=abcDEF123`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}?rel=0`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `https://www.youtube.com/live/${id}?feature=shared`,
      `https://music.youtube.com/watch?v=${id}&feature=share`,
      `  https://www.youtube.com/watch?v=${id}  `,
    ]) expect(parseYouTubeUrl(url), url).toEqual({ videoId: id, startAt: 0 });
  });

  it('keeps the start time', () => {
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=43')).toEqual({ videoId: 'dQw4w9WgXcQ', startAt: 43 });
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')?.startAt).toBe(90);
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1h2m3s')?.startAt).toBe(3723);
    expect(parseYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ?start=75')?.startAt).toBe(75);
    expect(parseYouTubeTime('1:02:03')).toBe(3723);
    expect(parseYouTubeTime('2:05')).toBe(125);
    expect(parseYouTubeTime('abc')).toBe(0);
    expect(parseYouTubeTime('-5')).toBe(0);
  });

  it('rejects everything that is not a YouTube video', () => {
    for (const bad of [
      '', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://evil.example/?u=https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ!',
      'https://www.youtube.com/channel/UC123', 'https://www.youtube.com/', 'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/', 'file:///home/me/video.mkv', `https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=${'a'.repeat(3000)}`,
      'https://user@evil.example/youtu.be/dQw4w9WgXcQ',
    ]) expect(parseYouTubeUrl(bad), bad.slice(0, 60)).toBeNull();
    expect(parseYouTubeUrl('https://user@youtube.com/watch?v=dQw4w9WgXcQ')?.videoId).toBe('dQw4w9WgXcQ');
  });

  it('finds the first video link in a chat message', () => {
    expect(findYouTubeLink('look at this https://youtu.be/dQw4w9WgXcQ?t=10, so good')).toEqual({ videoId: 'dQw4w9WgXcQ', startAt: 10 });
    expect(findYouTubeLink('(youtube.com/watch?v=dQw4w9WgXcQ)')?.videoId).toBe('dQw4w9WgXcQ');
    expect(findYouTubeLink('no links here, youtube is great')).toBeNull();
    expect(findYouTubeLink('https://youtube.com/channel/x and then https://youtu.be/aqz-KE-bpKQ')?.videoId).toBe('aqz-KE-bpKQ');
  });
});
