-- The cover letter's own system prompt, edited on the AI Settings screen.
-- Separate from the Resume's: two documents with two sets of rules, and one
-- prompt serving both would be edited for one and quietly change the other.
ALTER TABLE "ai_settings" ADD COLUMN "coverLetterPrompt" TEXT;

-- The letter written for one application, stored as the JSON its template
-- renders rather than as a file — so the same application downloads as either
-- format later, and always the letter that was actually written for it.
ALTER TABLE "bids" ADD COLUMN "coverLetterDocument" JSONB;
