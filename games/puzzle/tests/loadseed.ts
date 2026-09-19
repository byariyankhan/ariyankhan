// Seed the same shape the SQLite load test used, so the two sets of numbers can be read side by side:
// N signed-in players, most of them sitting in open rooms, behind a long history of finished matches.
import { pool, query } from '../backend/src/db.js';
import { migrate } from '../backend/src/migrate.js';
import { config } from '../backend/src/config.js';
import { hashToken, newToken } from '../backend/src/auth.js';
import { writeFileSync } from 'node:fs';

const USERS = Number(process.argv[2] ?? 1000);
const HISTORY = Number(process.argv[3] ?? 500_000);
await migrate();
await query(pool, 'TRUNCATE gold_ledger, match_players, matches, sessions, users RESTART IDENTITY CASCADE');

const tokens: string[] = [];
// COPY-style bulk inserts: the seeding is not what we are measuring.
const values: string[] = [];
for (let i = 1; i <= USERS; i++) values.push(`('test','sub${i}','Player ${i}','',1000000)`);
await query(pool, `INSERT INTO users (provider, sub, name, pic, gold) VALUES ${values.join(',')}`);
const ids = (await query<{ id: number }>(pool, 'SELECT id FROM users ORDER BY id')).rows.map(r => r.id);

const sess: string[] = [];
for (const id of ids) { const t = newToken(); tokens.push(t); sess.push(`('${hashToken(t)}',${id},now()+interval '30 days','app')`); }
for (let i = 0; i < sess.length; i += 500)
  await query(pool, `INSERT INTO sessions (token_hash, user_id, expires_at, client) VALUES ${sess.slice(i, i + 500).join(',')}`);

// 70% of them seated in rooms of five, the way a busy lobby looks
const seated = Math.floor(USERS * 0.7);
const rooms: string[] = [], seats: string[] = [];
let code = '', n = 0;
const codes: string[] = [];
for (let i = 0; i < seated; i++) {
  if (!code || n >= 5) {
    code = 'L' + i.toString(36).toUpperCase().padStart(5, '0');
    codes.push(code); n = 0;
    rooms.push(`('${code}',${ids[i]},${config.game.stakes[i % config.game.stakes.length]},'FRA',2,1234,'open',true,0,now()+interval '60 seconds',now())`);
  }
  seats.push(`('${code}',${ids[i]},2)`);
  n++;
}
for (let i = 0; i < rooms.length; i += 500)
  await query(pool, `INSERT INTO matches (code,host_id,stake,board,tier,seed,state,open_to_all,stakes_in,fills_at,created_at) VALUES ${rooms.slice(i, i + 500).join(',')}`);
for (let i = 0; i < seats.length; i += 500)
  await query(pool, `INSERT INTO match_players (code,user_id,tier) VALUES ${seats.slice(i, i + 500).join(',')}`);
await query(pool, `UPDATE matches m SET stakes_in = (SELECT COUNT(*) FROM match_players p WHERE p.code = m.code)`);

// The history: the thing that brought the SQLite service to its knees, because every sweep scanned it.
if (HISTORY > 0) {
  await query(pool, `INSERT INTO matches (code, host_id, stake, board, tier, seed, state, winner_id, open_to_all, stakes_in, created_at, started_at, settled_at)
    SELECT 'H' || g, $1, 1000, 'FRA', 2, 1, CASE WHEN g % 7 = 0 THEN 'void' ELSE 'done' END, $1, true, 2,
           now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'
      FROM generate_series(1, $2) g`, [ids[0], HISTORY]);
}
await query(pool, 'ANALYZE');

writeFileSync(new URL('./load-tokens.txt', import.meta.url), tokens.join('\n'));
writeFileSync(new URL('./load-codes.txt', import.meta.url), codes.join('\n'));
const counts = await query<{ matches: number; players: number }>(pool,
  'SELECT (SELECT COUNT(*) FROM matches) AS matches, (SELECT COUNT(*) FROM match_players) AS players');
console.log(`seeded users=${USERS} rooms=${codes.length} matches=${counts.rows[0]!.matches} seats=${counts.rows[0]!.players}`);
await pool.end();
