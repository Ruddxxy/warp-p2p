/**
 * Structured logger with level filtering.
 * In production, Vite strips all console.* calls via esbuild.drop.
 * This logger improves the dev experience by filtering noise based on VITE_LOG_LEVEL.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (import.meta.env.VITE_LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
  debug(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog('debug')) console.debug(`[${tag}]`, message, data ?? '');
  },
  info(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog('info')) console.log(`[${tag}]`, message, data ?? '');
  },
  warn(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog('warn')) console.warn(`[${tag}]`, message, data ?? '');
  },
  error(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog('error')) console.error(`[${tag}]`, message, data ?? '');
  },
};
