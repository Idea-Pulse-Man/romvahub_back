-- CreateTable
CREATE TABLE "auto_make_claims" (
    "bidId" UUID NOT NULL,
    "worker" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "failedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_make_claims_pkey" PRIMARY KEY ("bidId")
);

-- AddForeignKey
ALTER TABLE "auto_make_claims" ADD CONSTRAINT "auto_make_claims_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "bids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
