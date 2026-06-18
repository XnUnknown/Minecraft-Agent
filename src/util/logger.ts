/**
 * Minimal structured logger. Replaced/extended with file logging in a later stage
 * (so a shared brain can carry its own session history).
 */
const ts = (): string => new Date().toISOString();

export const logger = {
  info: (msg: string): void => console.log(`[${ts()}] INFO  ${msg}`),
  warn: (msg: string): void => console.warn(`[${ts()}] WARN  ${msg}`),
  error: (msg: string): void => console.error(`[${ts()}] ERROR ${msg}`),
};
