-- The fifth tier.
--
-- The difficulty ladder grew a fifth step, Master (tier 4), and the service learned to accept it (cleanLevels
-- clamps a tier to 0..4), but this table still said 0..3. So the first Master board a player cleared made every
-- push from that device fail: the whole batch is one statement in one transaction, one row broke the check, and
-- the device's boards, its daily training and its streaks stopped reaching the account at all — the phone and
-- the website each went on alone. Widening the check is all the fix there is on this side; the devices kept
-- everything they played, and their next push brings it.
--
-- The constraint was declared inline on the column, so PostgreSQL named it progress_tier_check.
ALTER TABLE progress DROP CONSTRAINT IF EXISTS progress_tier_check;
ALTER TABLE progress ADD CONSTRAINT progress_tier_check CHECK (tier BETWEEN 0 AND 4);
