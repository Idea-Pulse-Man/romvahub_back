-- CreateTable
CREATE TABLE "auto_make_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "workerSeenAt" TIMESTAMP(3),
    "currentBidId" UUID,
    "currentCompany" TEXT,
    "waitingReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_make_state_pkey" PRIMARY KEY ("id")
);
