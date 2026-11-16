-- Each application Profile may carry its own ChatGPT prompts for "Make":
-- the Resume's and the cover letter's. Null means "use the default".
ALTER TABLE "profiles" ADD COLUMN "resumePrompt" TEXT;
ALTER TABLE "profiles" ADD COLUMN "coverLetterPrompt" TEXT;
