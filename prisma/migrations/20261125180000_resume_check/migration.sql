-- The Resume check's result on each application, and "Remake" on the make queue.
ALTER TABLE "bids" ADD COLUMN "resumeCheckStatus" TEXT;
ALTER TABLE "bids" ADD COLUMN "resumeCheckReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "bids" ADD COLUMN "resumeCheckedAt" TIMESTAMP(3);
ALTER TABLE "bids" ADD COLUMN "resumeTextHash" TEXT;
CREATE INDEX "bids_resumeTextHash_idx" ON "bids"("resumeTextHash");
ALTER TABLE "auto_make_claims" ADD COLUMN "remake" BOOLEAN NOT NULL DEFAULT false;
