import { describe, expect, it } from 'vitest';
import { candidateInfo, decodeChunk, encodeChunk, isPrivateAddress, parseControl, parseSegmentKey, segmentKeyFromUrl } from '../src';

describe('peer wire format', () => {
  it('round-trips tagged binary chunks', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const c = decodeChunk(encodeChunk(0xdeadbeef, payload).buffer as ArrayBuffer)!;
    expect(c.id).toBe(0xdeadbeef);
    expect([...c.payload]).toEqual([1, 2, 3, 250]);
    expect(decodeChunk(new Uint8Array([1, 2]))).toBeNull();
  });

  it('accepts well-formed control messages only', () => {
    expect(parseControl('{"t":"get","id":1,"key":"abcd1234/v480/12.ts"}')).toEqual({ t: 'get', id: 1, key: 'abcd1234/v480/12.ts' });
    expect(parseControl('{"t":"res","id":1,"status":200,"size":1000}')).toMatchObject({ status: 200, size: 1000 });
    expect(parseControl('{"t":"have","keys":["abcd1234/a0/1.ts"],"reset":true}')).toEqual({ t: 'have', keys: ['abcd1234/a0/1.ts'], reset: true });
    for (const bad of [
      'nope', '[]', 'null', '{"t":"get","id":-1,"key":"abcd1234/v480/1.ts"}', '{"t":"get","id":1.5,"key":"abcd1234/v480/1.ts"}',
      '{"t":"get","id":1,"key":"../../etc/passwd"}', '{"t":"get","id":1,"key":"abcd1234/v480/index.m3u8"}',
      '{"t":"get","id":1,"key":"abcd1234/subs/en.vtt"}', '{"t":"res","id":1,"status":302,"size":1}',
      '{"t":"res","id":1,"status":200,"size":999999999999}', '{"t":"have","keys":"x"}', '{"t":"have","keys":["/etc/x"]}',
      `{"t":"have","keys":${JSON.stringify(Array(5000).fill('abcd1234/a0/1.ts'))}}`, '{"t":"evil"}',
    ]) expect(parseControl(bad), bad.slice(0, 60)).toBeNull();
  });

  it('maps segment URLs to keys and back', () => {
    expect(segmentKeyFromUrl('https://x.trycloudflare.com/media/abcd1234/v480/7.ts')).toBe('abcd1234/v480/7.ts');
    expect(segmentKeyFromUrl('/media/abcd1234/a1/0.ts?x=1')).toBe('abcd1234/a1/0.ts');
    expect(segmentKeyFromUrl('/media/abcd1234/v480/index.m3u8')).toBeNull();
    expect(segmentKeyFromUrl('/api/chat/images/abc')).toBeNull();
    expect(parseSegmentKey('abcd1234/v480/7.ts')).toEqual({ mediaId: 'abcd1234', rid: 'v480', index: 7 });
  });

  it('recognises addresses that must not be offered to strangers', () => {
    for (const a of ['10.0.0.5', '192.168.1.20', '172.20.3.4', '127.0.0.1', '169.254.1.1', '100.101.102.103', 'fe80::1', 'fd12::3', '::1', 'abc-123.local']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2a02:1234::5', '203.0.113.9']) expect(isPrivateAddress(a), a).toBe(false);
    expect(candidateInfo('candidate:1 1 UDP 2122317823 192.168.1.20 50000 typ host')).toEqual({ address: '192.168.1.20', type: 'host' });
    expect(candidateInfo('a=candidate:2 1 UDP 1686052607 203.0.113.9 61000 typ srflx raddr 0.0.0.0 rport 0')).toEqual({ address: '203.0.113.9', type: 'srflx' });
  });
});
