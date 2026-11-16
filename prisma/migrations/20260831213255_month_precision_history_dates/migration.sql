-- Work history and education dates become month precision (`YYYY-MM`).
--
-- A Resume prints "Aug 2024", so the day was never real data — it was whatever
-- the date picker happened to land on. `to_char` is spelled out rather than
-- left to the default cast, which would widen each DATE to a 'YYYY-MM-DD'
-- string and keep the digits nobody meant.

-- AlterTable
ALTER TABLE "work_experience"
  ALTER COLUMN "startDate" SET DATA TYPE TEXT USING to_char("startDate", 'YYYY-MM'),
  ALTER COLUMN "endDate"   SET DATA TYPE TEXT USING to_char("endDate", 'YYYY-MM');

-- AlterTable
ALTER TABLE "education"
  ALTER COLUMN "startDate" SET DATA TYPE TEXT USING to_char("startDate", 'YYYY-MM'),
  ALTER COLUMN "endDate"   SET DATA TYPE TEXT USING to_char("endDate", 'YYYY-MM');
