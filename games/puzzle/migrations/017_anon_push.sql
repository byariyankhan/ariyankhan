-- A phone, or a browser, that is not signed in can still be nudged at seven.
--
-- Until now a device only had somewhere to be reached once it belonged to an account: both tables required a
-- user. The evening reminder never needed a name -- it says "time to train your brain" -- and most players
-- never sign in, so the rows may now stand on their own. `user_id` is NULL for a device that has not signed
-- in; the moment it does, the same token or endpoint is posted again and the row takes the account (the
-- upsert already does that). Invitations and the league still need an account, and go by user_id as before.
--
-- The nudge's own switch used to be on the account (users.reminder). A device with no account keeps that
-- answer on its own row, and a signed-in one is still governed by the account's.
ALTER TABLE push_tokens        ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE push_tokens        ADD COLUMN IF NOT EXISTS reminder BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS reminder BOOLEAN NOT NULL DEFAULT true;
