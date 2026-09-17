-- DropIndex
DROP INDEX "api_cache_cache_key_key";

-- DropIndex
DROP INDEX "dramas_external_id_key";

-- DropIndex
DROP INDEX "favorites_user_id_drama_id_key";

-- DropIndex
DROP INDEX "watch_history_user_id_episode_id_key";

-- DropIndex
DROP INDEX "watch_history_user_id_last_watched_at_idx";

-- AlterTable
ALTER TABLE "api_cache" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'freereels';

-- AlterTable
ALTER TABLE "dramas" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'freereels';

-- AlterTable
ALTER TABLE "favorites" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'freereels';

-- AlterTable
ALTER TABLE "watch_history" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'freereels';

-- CreateIndex
CREATE UNIQUE INDEX "api_cache_provider_cache_key_key" ON "api_cache"("provider", "cache_key");

-- CreateIndex
CREATE UNIQUE INDEX "dramas_provider_external_id_key" ON "dramas"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_user_id_provider_drama_id_key" ON "favorites"("user_id", "provider", "drama_id");

-- CreateIndex
CREATE INDEX "watch_history_user_id_provider_last_watched_at_idx" ON "watch_history"("user_id", "provider", "last_watched_at");

-- CreateIndex
CREATE UNIQUE INDEX "watch_history_user_id_provider_episode_id_key" ON "watch_history"("user_id", "provider", "episode_id");