-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "sessionIdHash" TEXT,
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Application_status_statusChangedAt_idx" ON "Application"("status", "statusChangedAt");
