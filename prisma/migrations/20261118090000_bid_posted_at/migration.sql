-- When the job was posted, so stale Drafts can be expired each day.
ALTER TABLE "bids" ADD COLUMN "postedAt" TIMESTAMP(3);

CREATE INDEX "bids_status_postedAt_idx" ON "bids"("status", "postedAt");
