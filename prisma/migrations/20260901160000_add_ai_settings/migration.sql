-- CreateTable
CREATE TABLE "ai_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "model" TEXT,
    "systemPrompt" TEXT,
    "apiKeyEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- One row, enforced rather than assumed.
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_singleton" CHECK ("id" = 1);
