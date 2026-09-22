-- A nudge at seven in the evening, and where "evening" is.
--
-- Seven o'clock is a local fact. A device says which zone it is in when it registers for notifications, so
-- the reminder goes out at seven where the phone is and not at seven in Dhaka for everybody. The default is
-- Dhaka, for rows made before a device said anything and for a device that cannot say.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS tz TEXT NOT NULL DEFAULT 'Asia/Dhaka';
ALTER TABLE push_tokens        ADD COLUMN IF NOT EXISTS tz TEXT NOT NULL DEFAULT 'Asia/Dhaka';

-- Whether the account wants the nudge at all. On by default for anyone who has notifications on, off with
-- one switch in Settings; an invitation and the league are the promise notifications were turned on for,
-- and this is the one extra thing a player may say no to without giving those up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder BOOLEAN NOT NULL DEFAULT true;

-- When the account last posted a board or finished a race, so the nudge leaves alone anyone who has just
-- played. Written at most once in ten minutes, so a busy session is not a write per level.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_played_at TIMESTAMPTZ NOT NULL DEFAULT now();
