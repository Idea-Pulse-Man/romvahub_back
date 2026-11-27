-- The Resume in two steps: Step 1's prompt (the information the Resume needs) and Step 2's (the Resume).
ALTER TABLE "profiles" ADD COLUMN "resumeStep1Prompt" TEXT,
ADD COLUMN "resumeStep2Prompt" TEXT;
