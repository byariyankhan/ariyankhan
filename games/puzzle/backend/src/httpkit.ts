// The small pieces every route needs: who is asking, from where, and may they.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { userForToken, type User } from './auth.js';
import { check, LIMITS, subjectFor, type LimitName } from './ratelimit.js';

export interface Caller { user: User | null; token: string | null; ip: string; client: 'web' | 'app'; }

/** Parse a Cookie header without pulling in a plugin for it. */
export function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The session token, from either transport.
 *
 * A browser sends the HttpOnly cookie it was given. A phone app sends the very same token as a Bearer header
 * and never touches a cookie. The Bearer header wins when both are present, because an app that went to the
 * trouble of sending one means it.
 */
export function tokenFrom(req: FastifyRequest): { token: string | null; client: 'web' | 'app' } {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token) return { token, client: 'app' };
  }
  const jar = cookies(req.headers.cookie);
  const fromCookie = jar[config.auth.cookie];
  return { token: fromCookie ?? null, client: 'web' };
}

export async function caller(req: FastifyRequest): Promise<Caller> {
  const { token, client } = tokenFrom(req);
  return { user: await userForToken(token), token, ip: req.ip, client };
}

/** Send the session cookie a browser uses. An app ignores it and keeps the token from the response body. */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  const days = config.auth.sessionDays;
  const bits = [
    `${config.auth.cookie}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${days * 86400}`,
  ];
  if (config.cookieSecure) bits.push('Secure');
  reply.header('Set-Cookie', bits.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  const bits = [`${config.auth.cookie}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) bits.push('Secure');
  reply.header('Set-Cookie', bits.join('; '));
}

/** Apply a named limit. Returns true when the caller may proceed; sends the 429 itself when they may not. */
export async function limited(which: LimitName, req: FastifyRequest, reply: FastifyReply, userId: number | null): Promise<boolean> {
  const cfg = LIMITS[which];
  const verdict = await check(which, subjectFor(cfg, req.ip, userId));
  reply.header('X-RateLimit-Limit', String(verdict.limit));
  reply.header('X-RateLimit-Remaining', String(verdict.remaining));
  if (verdict.allowed) return true;
  reply.header('Retry-After', String(Math.max(1, verdict.retryAfter)));
  await reply.code(429).send({ error: 'rate_limited', retry_after: Math.max(1, verdict.retryAfter) });
  return false;
}

/** Nothing this API answers may be cached: it is all about right now. */
export const noStore = (reply: FastifyReply): FastifyReply => reply.header('Cache-Control', 'no-store');

export const body = (req: FastifyRequest): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

export const shapeUser = (u: User | null) =>
  u ? { id: u.id, name: u.name, provider: u.provider, pic: u.pic ?? '', gold: u.gold ?? 0, reminder: u.reminder !== false } : null;
