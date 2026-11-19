-- When an application was sent, and when its Resume was made: what the
-- Analytics page's daily numbers are counted from.
ALTER TABLE "bids" ADD COLUMN "appliedAt" TIMESTAMP(3),
ADD COLUMN "resumeMadeAt" TIMESTAMP(3);

-- Applications already sent: the day they were saved is the best record there
-- is. Noon UTC keeps the date the same in every US timezone.
UPDATE "bids"
SET "appliedAt" = "bidDate" + TIME '12:00'
WHERE "status" NOT IN ('Draft', 'Skip', 'Expired');

-- Resumes already stored: the first synced file, else when the job was saved
-- (the automatic maker makes it within minutes of that).
UPDATE "bids" b
SET "resumeMadeAt" = COALESCE(
  (SELECT MIN(f."createdAt") FROM "bid_resume_files" f WHERE f."bidId" = b."id"),
  b."createdAt"
)
WHERE b."resumeDocument" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "bid_resume_files" f WHERE f."bidId" = b."id");
