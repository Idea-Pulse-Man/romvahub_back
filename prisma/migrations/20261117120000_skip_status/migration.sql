-- "Skip": a job not worth applying to (a company over 500 employees, set
-- automatically when the job is added). No Resume or cover letter is made.
ALTER TYPE "bid_status" ADD VALUE IF NOT EXISTS 'Skip';
