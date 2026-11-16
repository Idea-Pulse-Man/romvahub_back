CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "senderId" UUID,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_recipientId_createdAt_idx"
ON "notifications"("recipientId", "createdAt" DESC);

CREATE INDEX "notifications_recipientId_readAt_idx"
ON "notifications"("recipientId", "readAt");

ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_senderId_fkey"
FOREIGN KEY ("senderId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
