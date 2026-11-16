-- The Resume files synced up from the desktop Resume Builder's folder: one row
-- per application and format (pdf, docx), replaced in place when the file changes.
CREATE TABLE "bid_resume_files" (
    "id" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bid_resume_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bid_resume_files_bidId_format_key" ON "bid_resume_files"("bidId", "format");

ALTER TABLE "bid_resume_files" ADD CONSTRAINT "bid_resume_files_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "bids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
