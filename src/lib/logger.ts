type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

function write(level: Level, scope: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (meta !== undefined) {
    const detail =
      meta instanceof Error
        ? meta.stack ?? meta.message
        : typeof meta === 'string'
          ? meta
          : JSON.stringify(meta);
    const out = `${line} ${detail}`;
    if (level === 'warn' || level === 'error') console.error(out);
    else console.log(out);
    return;
  }
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (scope: string, message: string, meta?: unknown) => write('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: unknown) => write('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => write('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => write('error', scope, message, meta),
};
