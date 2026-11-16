-- Structured address / identity fields on profiles, plus job title on work experience.

ALTER TABLE "profiles"
  ADD COLUMN "middleName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "addressLine" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "city" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "state" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "zipCode" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "county" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "country" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "linkedinUrl" TEXT NOT NULL DEFAULT '';

ALTER TABLE "work_experience"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
