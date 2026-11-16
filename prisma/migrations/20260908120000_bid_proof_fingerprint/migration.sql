-- What is in the proof screenshot, as a small RGB fingerprint (a 16×16 colour
-- thumbnail and a per-channel difference hash), so an uploaded screenshot can
-- be compared with every other application's without fetching any of them.
-- Null until a screenshot is uploaded, and for screenshots uploaded before
-- this existed until the backfill script has run.
ALTER TABLE "bids" ADD COLUMN "proofFingerprint" JSONB;
