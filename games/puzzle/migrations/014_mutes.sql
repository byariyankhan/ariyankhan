-- Somebody whose invitations a player does not want.
--
-- There is no friend list in this game: the people who may ask you to a match are the people you have
-- played, and until now the only thing between a player and being pestered was a rule on how often anyone
-- could ask. That rule got in the way of ordinary asking more than it stopped anything. This is the answer
-- the player gives once instead: mute, and that person's invitations never reach them again -- not on the
-- screen, not on the phone -- and the person is off their list. Undone in Settings, and never told to the
-- person muted.
CREATE TABLE IF NOT EXISTS mutes (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who muted
    muted_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- whom
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, muted_id)
);
