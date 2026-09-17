-- Progress belongs to the account, not to the phone.
--
-- Until now every board a player cleared lived in one browser's localStorage. Sign in on a new phone and the
-- gold came across but the tour started again at level 1 — the account remembered what they owned and nothing
-- about what they had done. This is the missing half.
--
-- The merge rule is the whole design, and it lives here rather than in the client on purpose: a player's two
-- devices sync in whatever order they happen to open, and neither may undo the other. So every field only ever
-- improves. More stars wins; at equal stars the faster time wins; cleared, skipped and quiz go from false to
-- true and never back. That makes a push idempotent and order-independent: an old phone opened after a month
-- uploads a worse run and changes nothing.

CREATE TABLE progress (
    user_id  BIGINT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The board's own id (a country id, or a discovery board's), never its number: the tour order is personal,
    -- so level 84 on one device is a different country from level 84 on another.
    level_id TEXT     NOT NULL CHECK (level_id <> '' AND length(level_id) <= 64),
    cleared  BOOLEAN  NOT NULL DEFAULT false,
    skipped  BOOLEAN  NOT NULL DEFAULT false,   -- unlocks the next board without having cleared this one
    quiz     BOOLEAN  NOT NULL DEFAULT false,
    ms       INTEGER  NULL     CHECK (ms IS NULL OR ms > 0),
    stars    SMALLINT NOT NULL DEFAULT 0 CHECK (stars BETWEEN 0 AND 3),
    tier     SMALLINT NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
    arrows   INTEGER  NOT NULL DEFAULT 0 CHECK (arrows >= 0 AND arrows <= 10000),
    at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, level_id)
);

-- Reading a player's whole tour is the common query, and the primary key already orders by user.
-- Nothing else reads this table, so it needs no other index.

-- The rest of what a new device needs before it can show the right tour at all: which country the player calls
-- home (the tour radiates from it), where the difficulty ladder had got to, and the daily boards they have
-- done. Small, read and written as one piece, and shaped by the client — a column of its own rather than a
-- table, because giving each of these a schema would freeze a part of the game that is still moving.
ALTER TABLE users ADD COLUMN state JSONB NOT NULL DEFAULT '{}'::jsonb;
