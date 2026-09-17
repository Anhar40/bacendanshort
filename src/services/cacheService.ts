/**
 * Cache engine database-first (PostgreSQL via Prisma).
 *
 * - Hit: data ada & expires_at masih valid → kembalikan dari DB.
 * - Stale-while-revalidate: data ada tapi expired → layani data lama,
 *   refresh berlangsung di background (job).
 * - Miss: tidak ada data → fetch dari source lalu simpan.
 * - Single-flight per cache_key: request identik yang bersamaan berbagi satu fetch.
 *
 * Tabel: api_cache (PRD §14).
 */
import { prisma } from '../db.js';
import type { Prisma, ApiCache } from '@prisma/client';
import type { DramaProviderId } from './providers.js';

const inflight = new Map<string, Promise<unknown>>();

export class CacheService {
  /**
   * Ambil dari cache bila valid; kalau tidak, panggil fetchFn lalu simpan.
   * fetchFn HARUS request via externalApiService (bukan langsung).
   * Cache key + baris DB diskop oleh provider (PRDUPDATE §20, §21).
   */
  /** Endpoint yang refresh-nya dipegang job background; lainnya pancing saat user request. */
  private readonly jobRefreshEndpoints = new Set(['foryou', 'homepage']);

  async getOrFetch<T>(
    cacheKey: string,
    endpoint: string,
    ttlSeconds: number,
    fetchFn: () => Promise<T>,
    requestParams: Record<string, string> = {},
    provider: DramaProviderId = 'freereels',
  ): Promise<T> {
    const row = await prisma.apiCache.findUnique({
      where: { provider_cacheKey: { provider, cacheKey } },
    });
    const now = new Date();

    if (row && row.expiresAt.getTime() > now.getTime()) {
      return this.unwrap<T>(row);
    }

    if (row && row.expiresAt.getTime() <= now.getTime()) {
      // Data kedaluwarsa: tetap layani data lama (stale-while-revalidate).
      // - foryou/homepage: refresh ditangani job background (tiap 10 menit);
      //   request masuk cukup dilayani data lama tanpa fetch.
      // - Endpoint lain (search/detail/episode/animepage/trending): tidak dirawat job,
      //   jadi pancing refresh background saat user request (tetap dilayani data lama).
      if (!this.jobRefreshEndpoints.has(endpoint)) {
        void this.refresh(cacheKey, endpoint, ttlSeconds, fetchFn, requestParams, provider).catch(() => {});
      }
      return this.unwrap<T>(row);
    }

    // cache miss → single-flight fetch (tunggu bila sedang di-fetch).
    const existing = this.singleFlight(
      cacheKey,
      async () => {
        const data = await fetchFn();
        await this.save(cacheKey, endpoint, ttlSeconds, data, requestParams, 'ok', provider);
        return data;
      },
    );
    return existing as Promise<T>;
  }

  /** Refresh sinkron (dipakai job background). */
  async refresh<T>(
    cacheKey: string,
    endpoint: string,
    ttlSeconds: number,
    fetchFn: () => Promise<T>,
    requestParams: Record<string, string> = {},
    provider: DramaProviderId = 'freereels',
  ): Promise<void> {
    await this.singleFlight(`refresh:${provider}:${cacheKey}`, async () => {
      try {
        const data = await fetchFn();
        await this.save(cacheKey, endpoint, ttlSeconds, data, requestParams, 'ok', provider);
      } catch (err) {
        const current = await prisma.apiCache.findUnique({
          where: { provider_cacheKey: { provider, cacheKey } },
        });
        if (current) {
          await prisma.apiCache.update({
            where: { id: current.id },
            data: {
              lastRefreshStatus: 'error',
              refreshAttempt: current.refreshAttempt + 1,
              updatedAt: new Date(),
            },
          });
        }
        throw err;
      }
    });
  }

  private singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = run().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  private async save<T>(
    cacheKey: string,
    endpoint: string,
    ttlSeconds: number,
    data: T,
    requestParams: Record<string, string>,
    status: string,
    provider: DramaProviderId,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const existing = await prisma.apiCache.findUnique({
      where: { provider_cacheKey: { provider, cacheKey } },
    });
    const payload = {
      provider,
      endpoint,
      requestParams: requestParams as Prisma.InputJsonValue,
      responseData: data as Prisma.InputJsonValue,
      expiresAt,
      cachedAt: now,
      lastRefreshStatus: status,
      // Sukses selalu reset penghitung percobaan agar backoff mulai dari nol.
      refreshAttempt: 0,
    };
    if (existing) {
      await prisma.apiCache.update({ where: { id: existing.id }, data: payload });
    } else {
      await prisma.apiCache.create({ data: { cacheKey, ...payload } });
    }
  }

  private unwrap<T>(row: ApiCache): T {
    if (!row.responseData) throw new Error('Cache kosong');
    let data: unknown = row.responseData;
    // cadangan response lama: yang disimpan adalah data yang mentah dari source
    if (
      typeof data === 'object' &&
      data !== null &&
      'data' in (data as Record<string, unknown>) &&
      'code' in (data as Record<string, unknown>)
    ) {
      data = (data as unknown as { data: T }).data;
    }
    return data as T;
  }
}

export const cacheService = new CacheService();