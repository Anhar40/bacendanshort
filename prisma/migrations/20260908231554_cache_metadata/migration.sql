-- AlterTable
ALTER TABLE "api_cache" ADD COLUMN     "last_refresh_status" TEXT DEFAULT 'ok',
ADD COLUMN     "refresh_attempt" INTEGER NOT NULL DEFAULT 0;
