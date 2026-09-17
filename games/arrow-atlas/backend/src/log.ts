// Structured logs, one JSON object per line, every one of them tagged with the product so a shared log drain
// can still tell Arrow Atlas apart from whatever else runs on the box.
import { config, PRODUCT } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const floor = ORDER[(config.logLevel as Level)] ?? ORDER.info;

// Anything that could carry a credential never reaches the log, whatever the caller passes. Auth tokens and
// Google's ID tokens are the ones that matter here, and they arrive under predictable names.
const SECRET = /^(password|pass|token|credential|id_token|authorization|cookie|secret|session|bearer|pg_password|redis_password)$/i;
const redact = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
};

const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
  if (ORDER[level] < floor) return;
  const line = { ts: new Date().toISOString(), level, product: PRODUCT, msg, ...(redact(fields ?? {}) as object) };
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  // An error object logs as a message and a stack, never as a mystery {}.
  err: (msg: string, e: unknown, fields?: Record<string, unknown>) =>
    emit('error', msg, { ...fields, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }),
};
