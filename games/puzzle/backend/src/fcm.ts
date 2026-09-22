// Reaching the app: Firebase Cloud Messaging, from this server, with nothing but Node's own crypto.
//
// The web's notifications go through Web Push (push.ts). The app's cannot: the Push API does not exist in a
// WebView, and a notification for a phone with the game closed has to come through the one channel Android
// keeps open for every app, which is FCM. What this module does is small and deliberately visible: it signs a
// JWT with the service account's private key, trades it for an access token, and POSTs one JSON message per
// phone to FCM's HTTP v1 endpoint. No SDK, because the SDK would be a hundred dependencies for four requests.
//
// The service account is the secret. It is the JSON file Firebase hands out, and it arrives here through the
// environment only -- written into the host's .env by the fcm-key mode of puzzle-ops, never into this
// repository, never printed. With nothing configured, `enabled` is false, every send is a no-op and the token
// endpoints answer "off" rather than failing: a deploy that has not had its key set is a game without
// notifications on phones, not a game that is broken.
import { createSign } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

/** What a notification says; structurally the same as push.ts's PushNote, kept separate so neither imports the other. */
export interface Note { kind: string; title: string; body: string; url: string; tag: string }

/**
 * The service account out of the environment, or null if what is there is not one.
 *
 * Raw JSON or base64 of it, because a .env line cannot hold the newlines a PEM key has, and base64 is the
 * form the fcm-key mode writes. Three fields are all that is ever read; a file missing any of them is not a
 * service account, whatever else it says.
 */
export function parseAccount(raw: string): ServiceAccount | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  let text = trimmed;
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { return null; }
  }
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const pid = j.project_id, email = j.client_email, key = j.private_key, uri = j.token_uri;
    if (typeof pid !== 'string' || !pid || typeof email !== 'string' || !email || typeof key !== 'string') return null;
    if (!key.includes('PRIVATE KEY')) return null;
    return { project_id: pid, client_email: email, private_key: key, ...(typeof uri === 'string' && uri ? { token_uri: uri } : {}) };
  } catch { return null; }
}

const account = parseAccount(config.fcm.serviceAccount);
export const enabled = account !== null;
export const projectId = account?.project_id ?? '';

if (enabled) log.info('app notifications are configured (FCM)', { project: projectId });
else log.info('app notifications are off (no FCM service account configured)');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const b64url = (s: string) => Buffer.from(s).toString('base64url');

/**
 * The signed JWT that asks Google for an access token on the account's behalf: RS256 over a header and the
 * claims Google's OAuth2 service-account flow specifies, valid for an hour. Pure, so a test can hand it a
 * throwaway key and check the signature with the matching public one.
 */
export function assertion(acct: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: acct.client_email, scope: SCOPE, aud: acct.token_uri || TOKEN_URI, iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(acct.private_key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/** The one message FCM is sent, per phone. Data only, so the app draws every notification itself, the same way whether it is open or not. */
export function messageFor(token: string, note: Note, ttlSeconds: number): Record<string, unknown> {
  return {
    message: {
      token,
      data: { kind: note.kind, title: note.title, body: note.body, url: note.url, tag: note.tag },
      android: {
        // An invitation is about a room that will be gone in minutes and is worth waking the phone for; the
        // league and the evening nudge can wait for the phone's next natural moment.
        priority: note.kind === 'invited' ? 'high' : 'normal',
        ttl: `${Math.max(0, Math.floor(ttlSeconds))}s`,
        // The same rule as the web's tag: invitations replace invitations, so five are one and not five.
        collapse_key: note.tag,
      },
    },
  };
}

let cached: { token: string; until: number } | null = null;
let minting: Promise<string | null> | null = null;

/**
 * The access token, minted when there is none and shared while it is being minted: a league payout sends to
 * everybody at once, and each of those sends asking Google for a credential of its own would be a burst of
 * identical requests for one token good for an hour.
 */
function accessToken(): Promise<string | null> {
  if (!account) return Promise.resolve(null);
  if (cached && cached.until > Date.now() + 60_000) return Promise.resolve(cached.token);
  if (!minting) minting = mint(account).finally(() => { minting = null; });
  return minting;
}

async function mint(acct: ServiceAccount): Promise<string | null> {
  const now = Date.now();
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(acct) });
  const r = await fetch(acct.token_uri || TOKEN_URI, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) { log.warn('fcm access token refused', { status: r.status }); return null; }
  const j = await r.json() as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  cached = { token: j.access_token, until: now + Math.max(60, j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export type Outcome = 'sent' | 'dead' | 'failed';

/**
 * One notification to one phone. Never throws.
 *
 * 'dead' is FCM saying this token will never work again -- UNREGISTERED, the app gone or the token rotated
 * away, or a string that was never a token -- and the caller deletes the row. 'failed' is this once.
 */
export async function send(token: string, note: Note, ttlSeconds: number): Promise<Outcome> {
  if (!account) return 'failed';
  try {
    const bearer = await accessToken();
    if (!bearer) return 'failed';
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(messageFor(token, note, ttlSeconds)),
    });
    if (r.ok) return 'sent';
    const text = await r.text().catch(() => '');
    if (r.status === 404 || /UNREGISTERED/.test(text)) return 'dead';
    if (r.status === 400 && /INVALID_ARGUMENT/.test(text) && /registration token/i.test(text)) return 'dead';
    if (r.status === 401) cached = null;   // the access token went stale early; the next send mints another
    log.warn('fcm send failed', { status: r.status, kind: note.kind });
    return 'failed';
  } catch (e) {
    log.err('fcm send threw', e, { kind: note.kind });
    return 'failed';
  }
}
