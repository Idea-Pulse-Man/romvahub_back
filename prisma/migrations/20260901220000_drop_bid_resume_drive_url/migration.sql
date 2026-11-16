-- Filing to Google Drive is gone, and this column held only the link to the
-- folder a Resume was filed into. Nothing renders it and nothing writes it any
-- more; the Resume itself lives in `resumeDocument`, which is what every
-- download is built from.

-- AlterTable
ALTER TABLE "bids" DROP COLUMN "resumeDriveUrl";
