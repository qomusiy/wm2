export { formatTime } from '@watchroom/protocol';

export function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 kb/s';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 0 : 1)} Mb/s`;
  return `${Math.round(bps / 1000)} kb/s`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (first + (second ?? '')).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 h 10 min", "45 min", "50 s". */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** "Today", "Yesterday", "3 days ago", or a date. */
export function formatDay(ts: number, now = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', ...(new Date(ts).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
