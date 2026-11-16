-- One account's own AI prompts, layered over the deployment's `ai_settings`.
-- A null column means "use the deployment's prompt", which in turn falls back
-- to the built-in default. Provider, model and key stay deployment-wide.
CREATE TABLE "user_ai_prompts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "systemPrompt" TEXT,
    "coverLetterPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_ai_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_ai_prompts_userId_key" ON "user_ai_prompts"("userId");

ALTER TABLE "user_ai_prompts" ADD CONSTRAINT "user_ai_prompts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
