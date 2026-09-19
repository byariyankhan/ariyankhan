-- An immutable record that a pot was paid, and to whom.
--
-- winner_id is a foreign key, so deleting an account set it to NULL; the payout's ledger row cascaded away with
-- the same deletion. A settled match therefore looked unsettled, and the next player to clear the board was
-- paid the very same pot again — gold created out of an account deletion. A finished match also rewrote itself
-- as a draw once its winner left.
--
-- paid_at and winner_name reference no user, so nothing can take them away. paid_at is what settlement guards
-- on from here; winner_id stays for "did *you* win", which a deleted account cannot have done.
ALTER TABLE matches ADD COLUMN paid_at     TIMESTAMPTZ NULL;
ALTER TABLE matches ADD COLUMN winner_name TEXT NOT NULL DEFAULT '';

-- Anything already settled keeps its history: the pot was paid when the match was settled.
UPDATE matches m
   SET paid_at = COALESCE(m.settled_at, m.created_at),
       winner_name = COALESCE((SELECT u.name FROM users u WHERE u.id = m.winner_id), '')
 WHERE m.winner_id IS NOT NULL;

-- The settlement guard reads this on every result, so it is worth an index of its own.
CREATE INDEX matches_unpaid_idx ON matches (code) WHERE state = 'playing' AND paid_at IS NULL;
