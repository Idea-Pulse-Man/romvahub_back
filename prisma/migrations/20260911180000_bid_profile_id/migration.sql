-- Applications belong to a first-class Profile so the admin switcher can scope lists.

ALTER TABLE "bids" ADD COLUMN "profileId" UUID;

CREATE INDEX "bids_profileId_status_idx" ON "bids"("profileId", "status");
CREATE INDEX "bids_profileId_bidDate_idx" ON "bids"("profileId", "bidDate");

ALTER TABLE "bids"
  ADD CONSTRAINT "bids_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Legacy 1:1: bid owner matched Profile.userId.
UPDATE "bids" AS b
SET "profileId" = p.id
FROM "profiles" AS p
WHERE p."userId" = b."userId"
  AND b."profileId" IS NULL;

-- Users shared with exactly one profile: attribute their unscoped bids there.
UPDATE "bids" AS b
SET "profileId" = s."profileId"
FROM (
  SELECT "userId", (array_agg("profileId"))[1] AS "profileId"
  FROM "profile_shares"
  GROUP BY "userId"
  HAVING COUNT(*) = 1
) AS s
WHERE b."userId" = s."userId"
  AND b."profileId" IS NULL;
