-- Where to reach a player who is not looking at the game.
--
-- A Web Push subscription is three strings the browser hands over: an endpoint URL at that browser's own push
-- service, and two keys the message is encrypted with. They are per browser, not per account — the same person
-- signed in on a phone and a laptop has two of these — so the endpoint is the identity and the account is what
-- it hangs off.
--
-- Three things this table has to get right:
--
--   * One row per endpoint. A browser re-subscribing with the same endpoint must update the row it already
--     has, not add a second one, or a single invite arrives twice on one phone.
--   * It follows the account. Sign in on this browser as somebody else and the endpoint moves with the sign-in
--     rather than keeping the old account's notifications alive on a device that has left it.
--   * It is disposable. A push service answers 404 or 410 when a subscription is dead, and the row is deleted
--     the moment it does: nothing here is worth keeping once the browser it belongs to has thrown it away.
--
-- Nothing in here is a secret of ours, but everything in it is personal: it is deleted with the account
-- (ON DELETE CASCADE) and never leaves the service.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    -- what the browser said it was, trimmed; only ever read by a person looking at why a device stopped working
    agent       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- moved forward every time the browser tells us it is still there, so a stale endpoint is findable
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- consecutive failures that were not fatal (a timeout, a 500 from the push service); reset by a success
    fails       INT NOT NULL DEFAULT 0
);

-- The one query that runs on every send: every endpoint belonging to this player.
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
