/**
 * Minimal structured logger.
 *
 * One line of JSON per event in production so the host's log collector can read
 * it; something readable by eye in development.
 *
 * `redact` exists because this server handles API keys and bearer tokens, and a
 * credential in a log file is a credential leaked. Nothing logs a raw secret.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
const asJson = process.env.NODE_ENV === "production";

/** Keeps the last 4 characters so a key can be matched to its owner in support. */
export function redact(secret: string | undefined | null): string {
  if (!secret) return "—";
  return secret.length <= 8 ? "***" : `***${secret.slice(-4)}`;
}

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), message, ...fields })}\n`,
    );
    return;
  }

  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  process.stdout.write(`[${level}] ${message}${extra}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
