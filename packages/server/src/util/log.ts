type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.WATCHROOM_LOG as Level) || 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < order[threshold]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra instanceof Error ? extra.message : extra);
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
