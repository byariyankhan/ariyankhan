-- Where to reach a phone that has the app.
--
-- The web has push_subscriptions: an endpoint at the browser's own push service and two keys. The app cannot
-- use that -- the Push API does not exist in a WebView -- so an invitation reaches a phone through Firebase
-- Cloud Messaging instead, and what FCM hands the app is one string, a registration token, per install. This
-- is the same table for the same reasons, with one column where the web had three.
--
--   * One row per token. The app posts its token every time the game opens with notifications on, so the row
--     is refreshed rather than duplicated, or one invitation arrives twice on one phone.
--   * It follows the account. Sign in on this phone as somebody else and the token moves with the sign-in.
--   * It is disposable. FCM answers UNREGISTERED when an app has been uninstalled or its token rotated away,
--     and the row is deleted the moment it does.
--
-- Nothing in here is a secret of ours; all of it is personal, deleted with the account, and never leaves the
-- service except in a request to Google addressed to that one phone.
CREATE TABLE IF NOT EXISTS push_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    platform    TEXT NOT NULL DEFAULT 'android',
    agent       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fails       INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id);
