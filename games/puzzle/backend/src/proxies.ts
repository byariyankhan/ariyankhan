// Which addresses are proxies we trust to say who the player is.
//
// A request reaches this service through nginx on the host, and nginx is reached through Cloudflare. Each of
// them appends the address it saw to X-Forwarded-For, so the player's own address is the rightmost one that
// is not a proxy of ours. Trusting the whole header -- the leftmost entry -- would mean believing whatever a
// script chose to write there, and every per-address rate limit would be a suggestion.
import proxyaddr from '@fastify/proxy-addr';
import type { IncomingMessage } from 'node:http';
import { config } from './config.js';

// Cloudflare's published ranges (https://www.cloudflare.com/ips/). They change rarely; PUZZLE_TRUSTED_PROXIES
// can carry a newer list without a release.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const list = config.trustedProxies.flatMap(n => n === 'cloudflare' ? CLOUDFLARE : [n]);

/** `(address, hop) => boolean`, the shape Fastify's trustProxy and proxy-addr both take. */
export const trust: (addr: string, hop: number) => boolean = list.length ? proxyaddr.compile(list) : () => false;

/** The player's address for a raw request (the WebSocket upgrade), by the same rule Fastify applies to req.ip. */
export function clientIp(req: IncomingMessage): string {
  try { return proxyaddr(req, trust) || req.socket.remoteAddress || 'unknown'; } catch { return req.socket.remoteAddress || 'unknown'; }
}
