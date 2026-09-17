// Test-only: create a player and a session token without going anywhere near Google.
// Prints "<user_id> <token>". Never shipped: it lives in tests/ and is not reachable over HTTP.
import { pool, query, tx } from '../backend/src/db.js';
import { give, idem } from '../backend/src/gold.js';
import { startSession } from '../backend/src/auth.js';

const name = process.argv[2] ?? 'Tester';
const gold = Number(process.argv[3] ?? 100_000);
const client = (process.argv[4] as 'web' | 'app') ?? 'web';

const out = await tx(async c => {
  const r = await query<{ id: number }>(c,
    `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, $2, 0)
     ON CONFLICT (provider, sub) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [`sub-${name}-${Date.now()}-${Math.random()}`, name]);
  const id = r.rows[0]!.id;
  if (gold > 0) await give(c, id, gold, 'admin', idem.admin(`mint:${id}`));
  return { id, token: await startSession(c, id, client) };
});
console.log(`${out.id} ${out.token}`);
await pool.end();
