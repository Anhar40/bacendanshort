/**
 * Job background sinkronisasi cache (PRD §13, §34, §35).
 *
 * - Jalan tiap 10 menit — TIDAK ada fetch agresif.
 * - Hanya menyegarkan baris api_cache endpoint foryou & homepage yang expires_at-nya
 *   sudah lewat; endpoint lain dibiarkan, di-cache saat user request saja.
 * - Refreshed berurutan dan diantrekan lewat externalApiService
 *   (rate limit default 8/mnt + single-flight).
 * - Refresh dilakukan pakai data endpoint & params yang tersimpan di baris cache.
 */
import { prisma } from '../db.js';
import { config } from '../config.js';
import { externalApiService } from '../services/externalApiService.js';
import { cacheService } from '../services/cacheService.js';
import type { DramaProviderId } from '../services/providers.js';

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_REFRESH_PER_RUN = 16;
/** Jeda antar log error refresh yang sama (panjang siklus × 3), biar log tidak spam. */
const REFRESH_ERROR_LOG_WINDOW_MS = 30 * 60 * 1000;

/** Endpoint yang dirawat job background. Sisanya hanya di-cache saat user request. */
const REFRESH_ENDPOINTS = new Set(['foryou', 'homepage', 'k-drama', 'hollywood-movies', 'indo-movies', 'detail', 'get-download-url', 'proxy-video']);

const lastErrorLog: Record<string, number> = {};

const TTL_BY_ENDPOINT: Record<string, number> = {
  foryou: config.FORYOU_TTL,
  trending: config.HOMEPAGE_TTL,
  homepage: config.HOMEPAGE_TTL,
  animepage: config.ANIME_TTL,
  latest: config.HOMEPAGE_TTL,
  anime: config.ANIME_TTL,
  search: config.SEARCH_TTL,
  detail: config.DETAIL_TTL,
  detailAndAllEpisode: config.DETAIL_TTL,
  episode: config.DETAIL_TTL,
  'k-drama': config.HOMEPAGE_TTL,
  'hollywood-movies': config.HOMEPAGE_TTL,
  'indo-movies': config.HOMEPAGE_TTL,
  'get-download-url': config.DETAIL_TTL,
  'proxy-video': config.DETAIL_TTL,
};

let running = false;

async function refreshExpired(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = await prisma.apiCache.findMany({
      where: { expiresAt: { lt: new Date() } },
      orderBy: { expiresAt: 'asc' },
      take: MAX_REFRESH_PER_RUN,
    });
    for (const row of expired) {
      // Baris lama dengan format cacheKey tanpa awalan provider (mis. "foryou:")
      // sudah usang — jangan disegarkan lagi (mencegah permintaan duplikat ke upstream).
      if (!row.cacheKey.startsWith(`${row.provider}:`)) continue;
      // Hanya rawat foryou & homepage lewat job; endpoint lain (search/detail/episode/
      // animepage/trending) dibiarkan — di-cache/di-segar-kan hanya saat user request.
      if (!REFRESH_ENDPOINTS.has(row.endpoint)) continue;
      // Backoff per baris: kalau refresh terus gagal (lastRefreshStatus='error'),
      // jangan coba lagi dalam jangka waktu tertentu — hindari menghantam API eksternal
      // yang sedang 403/404. makin sering gagal, makin lama jedanya (maks 10 menit).
      const attempt = row.refreshAttempt ?? 0;
      if (row.lastRefreshStatus === 'error' && attempt >= 2) {
        const backoffMs = Math.min(600_000, attempt * 120_000);
        if (row.updatedAt && Date.now() - row.updatedAt.getTime() < backoffMs) continue;
      }
      const ttl = TTL_BY_ENDPOINT[row.endpoint] ?? config.CACHE_DEFAULT_TTL;
      const params = (row.requestParams ?? {}) as Record<string, string>;
      const provider = row.provider as DramaProviderId;
      try {
        await cacheService.refresh(row.cacheKey, row.endpoint, ttl, async () => {
          const env = await externalApiService.request(provider, row.endpoint, params);
          return env.data;
        }, params, provider);
      } catch (err) {
        // Satu baris gagal (mis. upstream 404/403) tidak boleh menghentikan refresh baris lain.
        const dedupeKey = `${row.provider}/${row.endpoint}/${row.cacheKey}`;
        const now = Date.now();
        if ((lastErrorLog[dedupeKey] ?? 0) + REFRESH_ERROR_LOG_WINDOW_MS <= now) {
          lastErrorLog[dedupeKey] = now;
          console.error(`[refreshJob] Refresh gagal ${row.provider}/${row.endpoint} (${row.cacheKey}):`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error('[refreshJob] Gagal menyegarkan cache:', err);
  } finally {
    running = false;
  }
}

export function startRefreshJob(): void {
  void refreshExpired();
  setInterval(() => void refreshExpired(), REFRESH_INTERVAL_MS);
}