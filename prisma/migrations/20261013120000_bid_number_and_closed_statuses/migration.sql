-- Two more ways an application ends: the posting expired, or anything else the
-- existing statuses do not name.
ALTER TYPE "bid_status" ADD VALUE IF NOT EXISTS 'Expired';
ALTER TYPE "bid_status" ADD VALUE IF NOT EXISTS 'Other';

-- Every application gets a number within its filing scope — its Profile, or
-- its owner's legacy rows when it has none — counted up from 1 in the order
-- the applications were filed.
ALTER TABLE "bids" ADD COLUMN "number" INTEGER;

UPDATE "bids" AS b
SET "number" = ranked.rn
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "profileId", CASE WHEN "profileId" IS NULL THEN "userId" END
      ORDER BY "createdAt", "id"
    ) AS rn
  FROM "bids"
) AS ranked
WHERE ranked."id" = b."id";

ALTER TABLE "bids" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "bids_profileId_number_key" ON "bids"("profileId", "number");
