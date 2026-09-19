-- Gold that came from watching an advertisement, as its own reason.
--
-- It needs to be told apart from every other movement for three separate reasons, and each of them matters:
--
--   * the daily cap is counted by reading this reason back, so it has to be distinguishable from a payout;
--   * the league standings are a query over the ledger, and an ad is not play -- the league index lists the
--     reasons that count, and this is deliberately not one of them, so watching ads can never climb the table;
--   * if the reward ever has to be turned off or clawed back, the rows that came from it are findable.
--
-- The constraint is replaced whole rather than amended, the same way 004 did it, because the check may have
-- been created under either name and dropping by name alone would silently leave the old one in place.
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
    'signup', 'stake', 'leave_refund', 'expire_refund', 'draw_refund', 'payout', 'league', 'ad_reward', 'admin'));

-- The cap asks one question, many times a day: how many of these has this player claimed since midnight UTC.
-- Without an index that is a scan of their whole history; with it, it is a range read of a handful of rows.
CREATE INDEX IF NOT EXISTS gold_ledger_ad_idx ON gold_ledger (user_id, created_at)
    WHERE reason = 'ad_reward';
