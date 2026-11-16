-- First-class Profiles: optional legacy userId + share grants to Users.

ALTER TABLE "profiles" ALTER COLUMN "userId" DROP NOT NULL;

CREATE TABLE "profile_shares" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "profile_shares_profileId_userId_key" ON "profile_shares"("profileId", "userId");

CREATE INDEX "profile_shares_userId_idx" ON "profile_shares"("userId");

ALTER TABLE "profile_shares" ADD CONSTRAINT "profile_shares_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "profile_shares" ADD CONSTRAINT "profile_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing 1:1 ownership becomes an explicit share so admins can manage it.
INSERT INTO "profile_shares" ("id", "profileId", "userId", "createdAt")
SELECT gen_random_uuid(), "id", "userId", CURRENT_TIMESTAMP
FROM "profiles"
WHERE "userId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "profile_shares" ps
    WHERE ps."profileId" = "profiles"."id" AND ps."userId" = "profiles"."userId"
  );

-- Clear stub contact emails that were copied from the login address.
UPDATE "profiles" AS p
SET email = ''
FROM "users" AS u
WHERE p."userId" = u.id
  AND lower(p.email) = lower(u.email)
  AND p."firstName" = ''
  AND p."lastName" = '';
