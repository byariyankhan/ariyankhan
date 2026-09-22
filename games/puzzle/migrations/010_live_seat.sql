-- When a seat was last heard from, so a room can tell a player who is thinking from one who has gone.
--
-- A player can be signed in on a phone and in a browser at the same time, which is a feature, and it is also
-- how somebody ends up in a match they cannot see: start a challenge in a browser tab, close the tab, open
-- the app, and the app knows nothing about the room the account is still sitting in. Until now the only thing
-- that ever ended such a match was the twenty-four hour sweep, so the account was held in a board nobody was
-- playing for the rest of the day.
--
-- The server already hears from every live board a few times a minute: the client posts its progress on a
-- timer while a race is on screen, whether or not the number has moved. That is a heartbeat, and it was being
-- thrown away because the update only wrote when the percentage had grown. Now it stamps this column too, and
-- the sweeper can ask the only question that matters: has anybody been here recently?
--
-- Rows written before this existed read `now()`, which starts their clock at the migration rather than at
-- some point in the past. That is the safe direction: it gives an old match one more idle window before it is
-- swept, instead of settling a pile of history the moment this ships.
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- "Which match is this account still in?" — asked on every sign-in and every load, so it is worth an index.
-- Partial on the unfinished seats, because a player with two hundred matches behind them has at most one
-- ahead of them, and that is the only row this question wants.
CREATE INDEX IF NOT EXISTS match_players_live_idx ON match_players (user_id) WHERE ms IS NULL;
