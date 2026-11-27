-- AlterTable
ALTER TABLE "maker_computers" ADD COLUMN     "status" JSONB;

-- CreateTable
CREATE TABLE "maker_tasks" (
    "id" UUID NOT NULL,
    "worker" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "options" JSONB,
    "context" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "answer" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "maker_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maker_tasks_worker_status_idx" ON "maker_tasks"("worker", "status");

-- CreateIndex
CREATE INDEX "maker_tasks_createdAt_idx" ON "maker_tasks"("createdAt");

