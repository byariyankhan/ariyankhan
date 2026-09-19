-- The league: every week the gold you win at the tables is counted, and the ten best are paid.
--
-- Two tables and one new ledger reason. The standings themselves are not a table — they are a query over
-- gold_ledger, because the ledger already holds every movement of gold with the time it happened, and a
-- second running total kept beside it would be a second thing that can disagree with the balances.
--
-- What is stored is the part a query cannot rebuild later:
--   * league_seasons — which weeks exist, when each one ends, and whether it has been paid. The settled_at
--     column is the guard: a season is ranked and paid exactly once, under a row lock, whichever container
--     gets there first.
--   * league_prizes — the finished table, frozen. It has to be a snapshot: a player may delete their account
--     the day after the league ends, and last week's result should still read the way it read.

-- Prizes are gold like any other gold: they move through gold_ledger, so users.gold and the ledger still
-- agree. A reason of its own so a prize can be told apart from a pot won at a table — and so the standings
-- can leave it out, which stops last week's prize counting towards this week's rank.
-- The old constraint was written inline on the column, so PostgreSQL named it. It is dropped by what it says
-- rather than by that name: a database restored from an older dump, or built by a different tool, may have
-- named it something else, and leaving a second reason check behind would silently refuse every prize.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'gold_ledger'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE gold_ledger DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE gold_ledger ADD CONSTRAINT gold_ledger_reason_check CHECK (reason IN (
    'signup', 'stake', 'leave_refund', 'expire_refund', 'draw_refund', 'payout', 'league', 'admin'));

-- The standings scan asks one question — every match movement inside one week — and this index answers it
-- without reading the history. The predicate lists the reasons that count as play, so the prize rows, the
-- signup grant and any admin correction are not in the index at all.
CREATE INDEX gold_ledger_league_idx ON gold_ledger (created_at, user_id)
    WHERE reason IN ('stake', 'payout', 'leave_refund', 'expire_refund', 'draw_refund');

CREATE TABLE league_seasons (
    key         TEXT        PRIMARY KEY,           -- the Monday it starts, as a date: '2026-09-14'
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    settled_at  TIMESTAMPTZ     NULL,              -- when the prizes were paid; NULL means not yet
    CONSTRAINT league_seasons_span CHECK (ends_at > starts_at)
);
-- The sweep asks for the oldest season that has ended and has not been paid. Nothing else is scanned.
CREATE INDEX league_seasons_due_idx ON league_seasons (ends_at) WHERE settled_at IS NULL;

-- The finished table. One row per rank paid, with the name as it stood when the league ended: the account may
-- be renamed or deleted afterwards, and a result that changes after the fact is not a result.
CREATE TABLE league_prizes (
    season_key  TEXT        NOT NULL REFERENCES league_seasons(key) ON DELETE CASCADE,
    rank        SMALLINT    NOT NULL CHECK (rank >= 1),
    user_id     BIGINT          NULL REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT        NOT NULL DEFAULT '',
    pic         TEXT        NOT NULL DEFAULT '',
    earning     BIGINT      NOT NULL,              -- the gold they won at the tables that week
    gold        BIGINT      NOT NULL CHECK (gold > 0),   -- the prize this rank was paid
    PRIMARY KEY (season_key, rank)
);
CREATE INDEX league_prizes_user_idx ON league_prizes (user_id) WHERE user_id IS NOT NULL;
