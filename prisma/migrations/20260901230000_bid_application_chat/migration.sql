-- The questions beside an application became a conversation, so the column that
-- held `[{question, answer}]` now holds `[{role, content}]`.
--
-- Renamed rather than replaced, and the existing pairs are converted rather
-- than dropped: each question becomes the user's turn and its answer the
-- assistant's, in order, which is exactly what the pair meant.

-- AlterTable
ALTER TABLE "bids" RENAME COLUMN "applicationQuestions" TO "applicationChat";

-- Convert the stored pairs into turns.
UPDATE "bids" AS b
SET "applicationChat" = converted.messages
FROM (
  SELECT
    rows.id,
    jsonb_agg(rows.message ORDER BY rows.position, rows.turn) AS messages
  FROM (
    SELECT
      bid.id,
      pair.position,
      turn.turn,
      turn.message
    FROM "bids" AS bid
    CROSS JOIN LATERAL jsonb_array_elements(bid."applicationChat") WITH ORDINALITY AS pair(value, position)
    CROSS JOIN LATERAL (
      VALUES
        (1, jsonb_build_object('role', 'user', 'content', pair.value ->> 'question')),
        (2, jsonb_build_object('role', 'assistant', 'content', pair.value ->> 'answer'))
    ) AS turn(turn, message)
    WHERE bid."applicationChat" IS NOT NULL
      AND jsonb_typeof(bid."applicationChat") = 'array'
      -- Only rows still in the old shape. A `role` key means it has already
      -- been converted, which makes this safe to re-run.
      AND pair.value ? 'question'
      -- An unanswered question leaves no assistant turn behind.
      AND coalesce(turn.message ->> 'content', '') <> ''
  ) AS rows
  GROUP BY rows.id
) AS converted
WHERE b.id = converted.id;
