-- CreateTable
CREATE TABLE "maker_computers" (
    "worker" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "profileId" UUID,
    "order" TEXT NOT NULL DEFAULT 'up',
    "startFrom" INTEGER,
    "choices" JSONB,
    "startedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maker_computers_pkey" PRIMARY KEY ("worker")
);

