-- Jobs the scraper extension does not save for a Profile: roles (words in
-- the job title) and company names. Edited in Edit Profile → Avoid.
ALTER TABLE "profiles" ADD COLUMN "avoidRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "profiles" ADD COLUMN "avoidCompanies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
