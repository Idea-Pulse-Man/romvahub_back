-- The Source column goes away.
--
-- The form stopped asking for it once the answer was already in the job URL
-- sitting above it, and nothing reads the value any more — not the list, not
-- the details dialog, not the Resume. A column nobody reads is not history,
-- it is upkeep, so it is dropped rather than left behind nullable.
--
-- Destructive by design: the stored labels (LinkedIn, Indeed, …) are gone
-- after this, and a backup exported before it simply has its `source` key
-- ignored on import.

-- AlterTable
ALTER TABLE "bids" DROP COLUMN "source";
