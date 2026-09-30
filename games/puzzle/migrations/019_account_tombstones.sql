-- What is left of an account after it is deleted: that it existed, and nothing that says who it was.
--
-- Deleting an account takes its row, its sessions, its seats and every ledger row with it (ON DELETE CASCADE),
-- which is what a deletion should do -- and it took with it the only record that the account had already been
-- given its welcome gold. Signing in again with the same Google account made a new account, and the new
-- account was given 10,000 gold again. Delete, sign in, repeat: gold from nothing, as often as anybody liked.
--
-- So a deletion leaves this row. It holds the provider and a one-way hash of the provider's id,
-- sha256('puzzle-tombstone:' || provider || ':' || sub): enough to recognise the same Google account signing in
-- again, and not the id itself -- the raw id is deleted with the account, as it always was. A sign-in that makes
-- a new account for a hash found here makes it with no welcome gold.
--
-- ads_day and ads_used carry the day's advertisement claims across a deletion for the same reason: the daily cap
-- is counted from the ledger, and a fresh account used to be a fresh cap.
CREATE TABLE IF NOT EXISTS account_tombstones (
    provider    TEXT        NOT NULL,
    sub_hash    TEXT        NOT NULL CHECK (sub_hash ~ '^[0-9a-f]{64}$'),
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ads_day     DATE            NULL,              -- the UTC day ads_used counts
    ads_used    INTEGER     NOT NULL DEFAULT 0 CHECK (ads_used >= 0),
    PRIMARY KEY (provider, sub_hash)
);

-- The league counts a match in the week it started, so a match that straddles midnight on a Monday is counted
-- whole in one week rather than as a stake in one and a pot in the next. This is the index that finds a week's
-- matches without reading the history.
CREATE INDEX IF NOT EXISTS matches_started_idx ON matches (started_at);
