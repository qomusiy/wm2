import type { DeviceKind } from '@watchroom/protocol';
import { local } from './storage';

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function deviceId(): string {
  let id = local.get<string | null>('wr:device', null);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomString(20);
    local.set('wr:device', id);
  }
  return id;
}

export function nonce(): string {
  return randomString(12);
}

export function deviceKind(): DeviceKind {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || (touch && /Macintosh/.test(ua))) return 'tablet';
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android/.test(ua)) return 'mobile';
  return 'desktop';
}

export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
