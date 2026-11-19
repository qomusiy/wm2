/** Storage that never throws (private mode, blocked site data, quota). */
function safe(kind: 'local' | 'session') {
  const get = (): Storage | null => {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = get()?.getItem(key);
        return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(key: string, value: unknown): void {
      try {
        get()?.setItem(key, JSON.stringify(value));
      } catch { /* ignore */ }
    },
    remove(key: string): void {
      try {
        get()?.removeItem(key);
      } catch { /* ignore */ }
    },
  };
}

export const local = safe('local');
export const session = safe('session');
