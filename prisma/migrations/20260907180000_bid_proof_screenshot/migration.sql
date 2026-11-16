-- The screenshot of the job site's "thank you for applying" page, stored in the
-- bucket beside the candidate photos and named here by its object key. The
-- candidate uploads it when filing the application; an admin checks it.
ALTER TABLE "bids" ADD COLUMN "proofKey" TEXT;
