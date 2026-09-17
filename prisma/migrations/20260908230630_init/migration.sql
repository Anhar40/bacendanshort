-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "avatar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dramas" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "poster_url" TEXT,
    "cover_url" TEXT,
    "category" TEXT,
    "type" TEXT,
    "status" TEXT,
    "rating" TEXT,
    "release_year" INTEGER,
    "total_episodes" INTEGER,
    "view_count" BIGINT,
    "follow_count" BIGINT,
    "finish_status" INTEGER,
    "free" BOOLEAN,
    "external_data" JSONB,
    "cached_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "last_fetched_at" TIMESTAMP(3),
    "last_refresh_status" TEXT,
    "refresh_attempt" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dramas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episodes" (
    "id" TEXT NOT NULL,
    "drama_id" TEXT NOT NULL,
    "external_episode_id" TEXT NOT NULL,
    "episode_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "video_url" TEXT,
    "h264_m3u8_url" TEXT,
    "h265_m3u8_url" TEXT,
    "duration" INTEGER,
    "subtitle_list" JSONB,
    "external_data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_categories" (
    "drama_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "drama_categories_pkey" PRIMARY KEY ("drama_id","category_id")
);

-- CreateTable
CREATE TABLE "api_cache" (
    "id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_params" JSONB,
    "response_data" JSONB,
    "cached_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'fresh',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "drama_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "progress_seconds" INTEGER NOT NULL DEFAULT 0,
    "duration_seconds" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "last_watched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "drama_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "dramas_external_id_key" ON "dramas"("external_id");

-- CreateIndex
CREATE INDEX "episodes_drama_id_episode_number_idx" ON "episodes"("drama_id", "episode_number");

-- CreateIndex
CREATE UNIQUE INDEX "episodes_drama_id_external_episode_id_key" ON "episodes"("drama_id", "external_episode_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_cache_cache_key_key" ON "api_cache"("cache_key");

-- CreateIndex
CREATE INDEX "api_cache_expires_at_idx" ON "api_cache"("expires_at");

-- CreateIndex
CREATE INDEX "watch_history_user_id_last_watched_at_idx" ON "watch_history"("user_id", "last_watched_at");

-- CreateIndex
CREATE UNIQUE INDEX "watch_history_user_id_episode_id_key" ON "watch_history"("user_id", "episode_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_user_id_drama_id_key" ON "favorites"("user_id", "drama_id");

-- AddForeignKey
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_drama_id_fkey" FOREIGN KEY ("drama_id") REFERENCES "dramas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_categories" ADD CONSTRAINT "drama_categories_drama_id_fkey" FOREIGN KEY ("drama_id") REFERENCES "dramas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_categories" ADD CONSTRAINT "drama_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_drama_id_fkey" FOREIGN KEY ("drama_id") REFERENCES "dramas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_drama_id_fkey" FOREIGN KEY ("drama_id") REFERENCES "dramas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
