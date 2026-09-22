-- A match is a run of boards now.
--
-- One board took a minute or two, which is a sprint and not a match: nobody has time to fall behind and catch
-- up. A match plays one, three or five boards in a row -- the same boards for everybody, in the same order,
-- each with its own hearts and hints -- and the race is over when the last is cleared.
--
-- `boards` is the whole list, comma-separated; `board` stays the first of them so a client from before this
-- migration still opens something.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS boards TEXT NOT NULL DEFAULT '';
