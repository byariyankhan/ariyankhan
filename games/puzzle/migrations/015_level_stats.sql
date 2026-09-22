-- How hard each board actually is, counted from play rather than guessed.
--
-- The tour's records (progress) keep one line per board per account: the best run. They cannot say how many
-- tries that best run took, how many hearts it cost, or how many boards were given up on and never cleared,
-- which is the whole of what "hard" means. This table keeps the counts. Every device keeps its own on the
-- phone, offline or not, and posts them whenever it syncs the tour; the row is per account and per device, so
-- two phones on one account add up instead of overwriting each other, and a device that has never signed in
-- brings its counts with it the day it does.
--
-- The counts only ever grow, which is what makes the sync safe to repeat: a device posts its totals, the row
-- takes the larger of the two, and posting the same totals twice changes nothing.
CREATE TABLE IF NOT EXISTS level_stats (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device     TEXT   NOT NULL CHECK (device <> '' AND length(device) <= 40),
    level_id   TEXT   NOT NULL CHECK (level_id <> '' AND length(level_id) <= 64),
    plays      INTEGER NOT NULL DEFAULT 0 CHECK (plays >= 0),      -- boards started
    clears     INTEGER NOT NULL DEFAULT 0 CHECK (clears >= 0),     -- boards cleared
    fails      INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),      -- hearts run out
    hints      INTEGER NOT NULL DEFAULT 0 CHECK (hints >= 0),      -- hints spent on clears
    hearts     INTEGER NOT NULL DEFAULT 0 CHECK (hearts >= 0),     -- hearts lost on clears
    ms         BIGINT  NOT NULL DEFAULT 0 CHECK (ms >= 0),         -- time spent on clears
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device, level_id)
);
CREATE INDEX IF NOT EXISTS level_stats_level_idx ON level_stats (level_id);

-- The question itself, as one view: per board, how many people, how often it beats them, and what a clear
-- costs. tools/hardest.py and the stats mode of puzzle-ops both read this.
CREATE OR REPLACE VIEW level_difficulty AS
SELECT level_id,
       count(DISTINCT user_id)                                              AS players,
       sum(plays)                                                           AS plays,
       sum(clears)                                                          AS clears,
       sum(fails)                                                           AS fails,
       round(sum(fails)::numeric  / NULLIF(sum(plays), 0), 3)               AS fail_rate,
       round(sum(hints)::numeric  / NULLIF(sum(clears), 0), 2)              AS hints_per_clear,
       round(sum(hearts)::numeric / NULLIF(sum(clears), 0), 2)              AS hearts_per_clear,
       round(sum(ms)::numeric     / NULLIF(sum(clears), 0) / 1000, 1)       AS seconds_per_clear
  FROM level_stats
 GROUP BY level_id;
