-- Archiving from the Pipeline board.
ALTER TABLE "bids" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Interview steps: the interview process as the candidate tracks it.
CREATE TABLE "interview_steps" (
    "id" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "companyName" TEXT NOT NULL DEFAULT '',
    "scheduledAt" TIMESTAMP(0),
    "timezone" TEXT,
    "durationMinutes" INTEGER,
    "details" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interview_step_files" (
    "id" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_step_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interview_steps_bidId_position_idx" ON "interview_steps"("bidId", "position");
CREATE INDEX "interview_step_files_stepId_idx" ON "interview_step_files"("stepId");

ALTER TABLE "interview_steps" ADD CONSTRAINT "interview_steps_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "bids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_step_files" ADD CONSTRAINT "interview_step_files_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "interview_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
