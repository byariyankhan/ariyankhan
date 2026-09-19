-- Reading one board's times, for the comparison on the result card.
--
-- The card asks a narrow question: of everybody who cleared this board at this difficulty, how many were
-- slower than this run? The table is keyed by (user_id, level_id), so without this index that question means
-- reading every row of every player's tour. With it the answer is one small range of an index that is already
-- in the order the question asks for, and the rows that cannot take part — a skip, a board with no time —
-- are not in it at all.
CREATE INDEX IF NOT EXISTS progress_board_idx ON progress (level_id, tier, ms) WHERE cleared AND ms IS NOT NULL;
