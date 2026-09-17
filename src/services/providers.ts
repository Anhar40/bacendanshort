/**
 * Provider abstraction (PRDUPDATE §17–§18).
 *
 * FreeReels & Pine Drama punya struktur response berbeda; adapter di file ini
 * menormalkan keduanya menjadi bentuk internal yang sama (DramaSummary,
 * DramaDetail, EpisodeSummary, FeedEnvelope) sehingga route & UI tidak perlu
 * tahu perbedaan per-provider.
 *
 * Semua request keluar tetap lewat externalApiService (queue + rate limit +
 * single-flight) dan dicache di PostgreSQL dengan key + kolom provider.
 */
import { config } from '../config.js';
import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { cacheService } from './cacheService.js';
import { externalApiService, ContentUnavailableError } from './externalApiService.js';
import { upsertDramasFromFeed } from './dramaService.js';
import type { DramaDetail, DramaSummary, EpisodeSummary, FeedEnvelope } from './dramaService.js';

export type DramaProviderId = 'freereels' | 'pinedrama' | 'melolo' | 'moviebox';

export interface ProviderCapabilities {
  forYou: boolean;
  trending: boolean;
  search: boolean;
  detail: boolean;
  episode: boolean;
  anime: boolean;
  homepage: boolean;
}

export interface ProviderConfig {
  id: DramaProviderId;
  name: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDERS: Record<DramaProviderId, ProviderConfig> = {
  freereels: {
    id: 'freereels',
    name: 'FreeReels',
    capabilities: { forYou: true, trending: false, search: true, detail: true, episode: true, anime: true, homepage: true },
  },
  pinedrama: {
    id: 'pinedrama',
    name: 'Pine Drama',
    capabilities: { forYou: true, trending: true, search: true, detail: true, episode: true, anime: false, homepage: false },
  },
  melolo: {
    id: 'melolo',
    name: 'Melolo',
    capabilities: { forYou: true, trending: true, search: true, detail: true, episode: true, anime: true, homepage: true },
  },
  moviebox: {
    id: 'moviebox',
    name: 'MovieBox',
    capabilities: { forYou: false, trending: false, search: true, detail: true, episode: true, anime: false, homepage: true },
  },
};

export function isProvider(v: unknown): v is DramaProviderId {
  return v === 'freereels' || v === 'pinedrama' || v === 'melolo' || v === 'moviebox';
}

export function providerConfig(provider: DramaProviderId): ProviderConfig {
  return PROVIDERS[provider];
}

// ---------------------------------------------------------------------------
// Bentuk mentah Pine Drama (dari CONTOHEXECUTE/pinedrama — SOURCE OF TRUTH)
// ---------------------------------------------------------------------------

interface PineCollection {
  collection_id: string;
  title: string;
  description?: string | null;
  total_episodes?: number;
  views?: number;
  categories?: string | string[] | null;
  tags?: string[];
  cover?: string;
}

interface PineFeed {
  has_more?: boolean;
  cursor?: string | number;
  collections?: PineCollection[];
}

interface PineSearch {
  keyword?: string;
  page?: number;
  has_more?: boolean;
  results?: PineCollection[];
}

interface PineDetail {
  collection_id: string;
  title: string;
  description?: string;
  total_episodes?: number;
  views?: number;
  type?: string;
  episode_label?: string;
  cover_urls?: string[];
  channel?: string;
  channel_id?: string;
  channel_unique_id?: string;
  channel_desc?: string;
  channel_followers?: number;
  channel_region?: string;
  avatar_urls?: string[];
}

interface PineCdnGroup {
  indo_hd_cdn_urls?: string[];
  indo_cdn_urls?: string[];
  cdn_urls?: string[];
}

interface PineEpisode {
  episode_num?: number;
  video_id?: string;
  title?: string;
  main?: PineCdnGroup & { desc?: string };
  alt?: PineCdnGroup & { desc?: string };
  best_url?: string;
  quality?: string;
}

// ---------------------------------------------------------------------------
// Normalisasi → bentuk internal
// ---------------------------------------------------------------------------

function pineCollectionToSummary(c: PineCollection, moduleType?: string, moduleKey?: string): DramaSummary {
  const categories = Array.isArray(c.categories)
    ? c.categories
    : c.categories
      ? (c.categories as string).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
  return {
    id: c.collection_id,
    title: c.title,
    cover: c.cover ?? '',
    description: c.description ?? '',
    tags: [...(c.tags ?? []), ...categories],
    moduleType,
    moduleKey,
  };
}

// ---------------------------------------------------------------------------
// ProviderService
// ---------------------------------------------------------------------------

class ProviderService {
  /**
   * Feed For You per provider.
   * `page` adalah token next dari page_info sebelumnya (kosong = halaman awal).
   * Peta ke parameter eksternal sesuai provider: freereels→page, pinedrama→cursor.
   */
  async forYou(provider: DramaProviderId, page = ''): Promise<FeedEnvelope> {
    if (provider === 'melolo') {
      return this.meloloFeed('foryou', `melolo:foryou:${page}`, 'foryou', page, config.FORYOU_TTL, 'foryou');
    }
    if (provider === 'pinedrama') {
      // Pinedrama: cursor=1 untuk pagination pertama, cursor=2 untuk kedua, dst.
      const cursor = page ? page : '1';
      const extParams: Record<string, string> = { cursor };
      const raw = await cacheService.getOrFetch<PineFeed>(
        `pinedrama:foryou:${page}`,
        'foryou',
        config.FORYOU_TTL,
        async () => (await externalApiService.request<PineFeed>('pinedrama', 'foryou', extParams)).data,
        extParams,
        'pinedrama',
      );
      const items = (raw?.collections ?? []).map((c) => pineCollectionToSummary(c, 'foryou', 'foryou'));
      this.persistFeed('pinedrama', items, 'foryou', 'foryou', 'foryou');
      return {
        page_info: { next: this.pineFeedNext(cursor, raw), has_more: !!raw?.has_more },
        items,
      };
    }
    return this.freereelsFeed('foryou', `freereels:foryou:${page}`, 'foryou', page, config.FORYOU_TTL);
  }

  async trending(provider: DramaProviderId, page = ''): Promise<FeedEnvelope> {
    if (provider === 'melolo') {
      return this.meloloFeed('trending', `melolo:trending:${page}`, 'trending', page, config.HOMEPAGE_TTL, 'trending');
    }
    // Pinedrama: cursor=1 untuk pagination pertama, cursor=2 untuk kedua, dst.
    const cursor = page ? page : '1';
    const extParams: Record<string, string> = { cursor };
    const raw = await cacheService.getOrFetch<PineFeed>(
      `pinedrama:trending:${page}`,
      'trending',
      config.HOMEPAGE_TTL,
      async () => (await externalApiService.request<PineFeed>('pinedrama', 'trending', extParams)).data,
      extParams,
      'pinedrama',
    );
    const items = (raw?.collections ?? []).map((c) => pineCollectionToSummary(c, 'trending', 'trending'));
    this.persistFeed('pinedrama', items, 'trending', 'trending', 'trending');
    return {
      page_info: { next: this.pineFeedNext(cursor, raw), has_more: !!raw?.has_more },
      items,
    };
  }

  async home(provider: DramaProviderId, page = ''): Promise<FeedEnvelope> {
    if (provider === 'moviebox') {
      return this.movieboxHome();
    }
    if (provider === 'melolo') {
      return this.meloloHome();
    }
    if (provider === 'pinedrama') {
      // Tidak ada endpoint homepage pinedrama → susun dari trending + foryou.
      const [trending, foryou] = await Promise.all([this.trending(provider), this.forYou(provider)]);
      const seen = new Set<string>();
      const items: DramaSummary[] = [];
      for (const it of [
        ...trending.items.map((t) => ({ ...t, moduleKey: 'trending' as string | undefined, moduleType: 'trending' as string | undefined })),
        ...foryou.items.map((t) => ({ ...t, moduleKey: 'foryou' as string | undefined, moduleType: 'foryou' as string | undefined })),
      ]) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      this.persistFeed('pinedrama', items, undefined, undefined, 'home');
      return { page_info: { next: '', has_more: false }, items };
    }
    return this.freereelsFeed('homepage', page ? `freereels:homepage:${page}` : 'freereels:homepage', 'homepage', page, config.HOMEPAGE_TTL);
  }

  async anime(provider: DramaProviderId): Promise<FeedEnvelope> {
    if (!providerConfig(provider).capabilities.anime) {
      return { page_info: { next: '', has_more: false }, items: [] };
    }
    if (provider === 'melolo') {
      return this.meloloFeed('anime', 'melolo:anime', 'anime', '', config.ANIME_TTL, 'anime');
    }
    return this.freereelsFeed('animepage', 'freereels:animepage', 'animepage', '', config.ANIME_TTL);
  }

  /**
   * Token next halaman pinedrama.
   * - Response ping tersedia & bukan echo dari token yang diminta → pakai apa adanya
   *   (trending memakai token opaque seperti "7678567879017092114:2026090700:1").
   * - Cursor angka yang sering echo posisi saat ini (foryou) → majukan +1 supaya tidak loop.
   */
  private pineFeedNext(pageToken: string, raw: PineFeed | undefined): string {
    if (!raw?.has_more) return '';
    const req = Number(pageToken);
    const cur: unknown = raw.cursor;
    if (typeof cur === 'string' && cur && cur !== pageToken) return cur;
    if (typeof cur === 'number' && Number.isInteger(req) && cur > req) return String(cur);
    return Number.isInteger(req) ? String(req + 1) : '';
  }

  async search(provider: DramaProviderId, query: string, page = ''): Promise<{ items: DramaSummary[]; next: string; hasMore: boolean }> {
    if (provider === 'moviebox') {
      const extParams: Record<string, string> = { query };
      if (page) extParams.page = page;
      const raw = await cacheService.getOrFetch<MovieBoxSearch>(
        `moviebox:search:${query}:${page}`,
        'search',
        config.SEARCH_TTL,
        async () => (await externalApiService.request<MovieBoxSearch>('moviebox', 'search', extParams)).data,
        extParams,
        'moviebox',
      );
      const items: DramaSummary[] = [];
      const seen = new Set<string>();
      for (const grp of raw?.results ?? []) {
        for (const s of grp.subjects ?? []) {
          const id = String(s.subjectId ?? '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          items.push(this.movieBoxSubjectToSummary(s));
        }
      }
      let next = '';
      if (raw?.pager?.hasMore) {
        const cur = Number(page) || Number(raw.pager.page) || 1;
        next = String(cur + 1);
      }
      this.persistFeed('moviebox', items, undefined, undefined, 'search');
      return { items, next, hasMore: !!next };
    }
    if (provider === 'melolo') {
      const extParams: Record<string, string> = { query, limit: '25' };
      if (page) extParams.offset = page;
      const raw = await cacheService.getOrFetch<MeloloObject | undefined>(
        `melolo:search:${query}:${page}`,
        'search',
        config.SEARCH_TTL,
        async () => (await externalApiService.request<MeloloObject | undefined>('melolo', 'search', extParams)).data,
        extParams,
        'melolo',
      );
      const items = this.meloloItems(raw).map((it) => this.meloloItemToSummary(it));
      const next = this.meloloFeedNext(page, raw);
      this.persistFeed('melolo', items, undefined, undefined, 'search');
      return { items, next, hasMore: !!next };
    }
    if (provider === 'pinedrama') {
      const extParams: Record<string, string> = { query };
      if (page) extParams.page = page;
      const raw = await cacheService.getOrFetch<PineSearch>(
        `pinedrama:search:${query}:${page}`,
        'search',
        config.SEARCH_TTL,
        async () => (await externalApiService.request<PineSearch>('pinedrama', 'search', extParams)).data,
        extParams,
        'pinedrama',
      );
      const items = (raw?.results ?? []).map((c) => pineCollectionToSummary(c));
      this.persistFeed('pinedrama', items, undefined, undefined, 'search');
      return {
        items,
        next: raw?.has_more ? '1' : '',
        hasMore: !!raw?.has_more,
      };
    }
    // freereels: search via cache per query (tanpa pagination tambahan).
    const raw = await cacheService.getOrFetch<{ items?: unknown[] }>(
      `freereels:search:${query}`,
      'search',
      config.SEARCH_TTL,
      async () => (await externalApiService.request<{ items?: unknown[] }>('freereels', 'search', { query })).data,
      { query },
      'freereels',
    );
    const items = (raw?.items ?? []).map((it) => this.freereelsItemToSummary(it as FreereelsFeedItem));
    this.persistFeed('freereels', items, undefined, undefined, 'search');
    return { items, next: '', hasMore: false };
  }

  async detail(provider: DramaProviderId, externalId: string): Promise<DramaDetail> {
    if (provider === 'moviebox') {
      return this.movieboxDetail(externalId);
    }
    if (provider === 'melolo') {
      const raw = await cacheService.getOrFetch<MeloloObject | undefined>(
        `melolo:detail:${externalId}`,
        'detail',
        config.DETAIL_TTL,
        async () => (await externalApiService.request<MeloloObject | undefined>('melolo', 'detail', { book_id: externalId })).data,
        { book_id: externalId },
        'melolo',
      );
      const vd = raw && typeof raw.video_data === 'object' ? (raw.video_data as MeloloObject) : undefined;
      const id = vd ? meloloId(vd) : '';
      if (!id) throw new ContentUnavailableError(externalId);
      const episodes = this.meloloDetailEpisodes(vd);
      const episodeCount = episodes.length > 0 ? episodes.length : meloloCount(vd, episodes.length);
      const detail: DramaDetail = {
        id,
        title: meloloPick(vd, ['series_title', 'title', 'book_name', 'name'], ''),
        cover: meloloPick(vd, ['series_cover', 'cover', 'thumb_url', 'first_chapter_cover', 'image'], ''),
        description: meloloPick(vd, ['series_intro', 'abstract', 'description', 'desc', 'sinopsis'], ''),
        tags: meloloTags(vd),
        episodeCount,
        episodes,
      };
      await this.persistDetail('melolo', detail, 'detail').catch((err) => {
        console.warn('[provider:melolo] Simpan detail drama gagal (dilewati):', (err as Error).message);
      });
      return detail;
    }
    if (provider === 'pinedrama') {
      const raw = await cacheService.getOrFetch<PineDetail>(
        `pinedrama:detail:${externalId}`,
        'detail',
        config.DETAIL_TTL,
        async () => (await externalApiService.request<PineDetail>('pinedrama', 'detail', { collection_id: externalId })).data,
        { collection_id: externalId },
        'pinedrama',
      );
      if (!raw?.collection_id) throw new ContentUnavailableError(externalId);
      const total = raw.total_episodes ?? 0;
      const detail: DramaDetail = {
        id: raw.collection_id,
        title: raw.title,
        cover: raw.cover_urls?.[0] ?? '',
        description: raw.description ?? '',
        tags: [],
        episodeCount: total,
        // Tidak ada daftar episode di detail → placeholder 1..N; stream dimuat per episode.
        episodes: Array.from({ length: total }, (_, i) => ({
          id: `${raw.collection_id}:ep${i + 1}`,
          number: i + 1,
          title: `Episode ${i + 1}`,
          cover: '',
          streamUrl: '',
          subtitles: [],
        })),
      };
      await this.persistDetail('pinedrama', detail, 'detail').catch((err) => {
        console.warn('[provider:pinedrama] Simpan detail drama gagal (dilewati):', (err as Error).message);
      });
      return detail;
    }
    return this.freereelsDetail(externalId);
  }

  async episode(provider: DramaProviderId, externalId: string, episodeNum: number, requestOrigin?: string): Promise<EpisodeSummary> {
    if (provider === 'moviebox') {
      // Film (subjectType=1) TIDAK punya season → upstream minta `season=0` (balasan
      // "Film ini tidak memiliki season. Gunakan season = 0."). Seri pakai season=1.
      // Coba beberapa kombinasi; hanya hasil yang benar-benar berisi stream di-cache.
      const attempts: Array<{ season: string; episode: string }> = [
        { season: '1', episode: String(episodeNum) },
        { season: '0', episode: String(episodeNum) },
        { season: '0', episode: '0' },
      ];
      let raw: MovieBoxStream | undefined;
      let resolveError: ContentUnavailableError | undefined;
      try {
        raw = await cacheService.getOrFetch<MovieBoxStream>(
          `moviebox:stream:${externalId}:${episodeNum}`,
          'get-download-url',
          config.DETAIL_TTL,
          async () => {
            let lastErr: unknown;
            const notes: string[] = [];
            for (const attempt of attempts) {
              try {
                const env = await externalApiService.request<MovieBoxStream>('moviebox', 'get-download-url', {
                  subjectId: externalId,
                  ...attempt,
                });
                const candidate = env.data;
                const stream = candidate && Array.isArray(candidate.streams) ? candidate.streams[0] : undefined;
                if (stream && typeof stream.url === 'string' && stream.url) return candidate;
                // upstream balas tanpa stream → catat lalu coba kombinasi lain.
                const snippet =
                  candidate && typeof candidate === 'object' && 'success' in candidate
                    ? JSON.stringify(candidate).slice(0, 160)
                    : 'no stream';
                notes.push(`s${attempt.season}e${attempt.episode}=>${snippet}`);
              } catch (err) {
                lastErr = err;
              }
            }
            // Ada error infrastruktur asli (gagal fetch) → kasih tahu & biarkan 502/error apa adanya.
            if (lastErr) {
              console.warn(`[moviebox] get-download-url gagal ${externalId}:${episodeNum} :: ${(lastErr as Error).message}`);
              throw lastErr;
            }
            console.warn(`[moviebox] get-download-url tanpa stream ${externalId}:${episodeNum} :: ${notes.join(' | ')}`);
            throw new ContentUnavailableError(externalId);
          },
          { subjectId: externalId, episode: String(episodeNum), season: '1' },
          'moviebox',
        );
      } catch (err) {
        // get-download-url gagal melempar (mis. konten film tanpa stream seri) →
        // JANGAN langsung 404; tangkap dulu untuk mencoba jalur fallback film.
        if (err instanceof ContentUnavailableError) {
          resolveError = err;
        } else {
          throw err;
        }
      }
      const stream = raw && Array.isArray(raw.streams) ? raw.streams[0] : undefined;
      const rawUrl = stream && typeof stream.url === 'string' && stream.url ? stream.url : '';
      if (!rawUrl) {
        // Baris cache lama yang terisi hasil kosong/gagal (sebelum perbaikan) tidak boleh
        // mengunci 404 selamanya → hapus, supaya request berikutnya mencoba ulang ke upstream.
        void prisma.apiCache
          .deleteMany({
            where: { provider: 'moviebox', cacheKey: `moviebox:stream:${externalId}:${episodeNum}` },
          })
          .catch(() => undefined);
        // Film (subjectType=1) TIDAK disajikan lewat get-download-url — stream aslinya
        // ada di `detail.resourceDetectors[].resolutionList[].resourceLink` (MP4 signed).
        const filmEp = await this.movieboxFilmEpisode(externalId, episodeNum, requestOrigin);
        if (filmEp) return filmEp;
        throw resolveError ?? new ContentUnavailableError(externalId);
      }
      // Bungkus lewat `proxy-video` (alur resmi app moviebox) → URL `cdn-proxy`
      // yang bisa diputar; lalu rewire host ke domain backend kita agar mobile
      // tidak pernah langsung menyentuh upstream/CDN.
      const playUrl = await this.movieboxPlayUrl(externalId, episodeNum, rawUrl, stream?.signCookie, requestOrigin);
      if (!playUrl) throw new ContentUnavailableError(externalId);
      const subtitles: EpisodeSummary['subtitles'] = Array.isArray(raw?.subtitles)
        ? raw.subtitles
            .filter((s) => s && typeof s.url === 'string' && s.url)
            .map((s) => ({ language: s.lan ?? '', displayName: s.lanName ?? s.lan ?? '', url: s.url as string }))
        : [];
      const ep: EpisodeSummary = {
        id: `${externalId}:se1ep${episodeNum}`,
        number: episodeNum,
        title: raw?.title ?? `Episode ${episodeNum}`,
        cover: '',
        streamUrl: playUrl,
        subtitles,
      };
      const extData: Prisma.JsonObject = { provider: 'moviebox', rawUrl, subtitles };
      // Simpan streamUrl + metadata ke DB (untuk continue-watching / detail selanjutnya).
      void (async () => {
        const drama = await prisma.drama.findUnique({
          where: { provider_externalId: { provider: 'moviebox', externalId } },
        });
        if (drama) {
          await prisma.episode.upsert({
            where: { dramaId_externalEpId: { dramaId: drama.id, externalEpId: ep.id } },
            create: {
              dramaId: drama.id,
              externalEpId: ep.id,
              episodeNumber: ep.number,
              title: ep.title,
              videoUrl: playUrl,
              externalData: extData,
            },
            update: {
              title: ep.title,
              videoUrl: playUrl,
              externalData: extData,
            },
          });
        }
      })().catch(() => undefined);
      return ep;
    }
    if (provider === 'melolo') {
      const streamUrl = await this.meloloEpisodeStream(externalId, episodeNum);
      if (!streamUrl) throw new ContentUnavailableError(externalId);
      return {
        id: `${externalId}:ep${episodeNum}`,
        number: episodeNum,
        title: `Episode ${episodeNum}`,
        cover: '',
        streamUrl,
        subtitles: [],
      };
    }
    if (provider === 'pinedrama') {
      const raw = await cacheService.getOrFetch<PineEpisode>(
        `pinedrama:episode:${externalId}:${episodeNum}`,
        'get-episode',
        config.DETAIL_TTL,
        async () =>
          (
            await externalApiService.request<PineEpisode>('pinedrama', 'get-episode', {
              collection_id: externalId,
              episodeNumber: String(episodeNum),
            })
          ).data,
        { collection_id: externalId, episodeNumber: String(episodeNum) },
        'pinedrama',
      );
      const groups = [raw?.best_url, raw?.main, raw?.alt]
        .filter((g): g is string | PineCdnGroup => !!g)
        .flatMap((g) => (typeof g === 'string' ? [g] : [...(g.indo_hd_cdn_urls ?? []), ...(g.indo_cdn_urls ?? []), ...(g.cdn_urls ?? [])]));
      const streamUrl = groups.find((u) => !!u) ?? '';
      if (!streamUrl) throw new ContentUnavailableError(externalId);
      // simpan streamUrl ke DB (untuk continue-watching/detail selanjutnya)
      void (async () => {
        const drama = await prisma.drama.findUnique({
          where: { provider_externalId: { provider: 'pinedrama', externalId } },
        });
        if (drama) {
          await prisma.episode.updateMany({
            where: { dramaId: drama.id, episodeNumber: episodeNum },
            data: { videoUrl: streamUrl },
          });
        }
      })().catch(() => undefined);
      return {
        id: `${externalId}:ep${episodeNum}`,
        number: episodeNum,
        title: raw?.title ?? `Episode ${episodeNum}`,
        cover: '',
        streamUrl,
        subtitles: [],
      };
    }
    // freereels: stream sudah tersedia di detail (dari DB/external).
    const detail = await this.detail('freereels', externalId);
    const ep = detail.episodes.find((e) => e.number === episodeNum);
    if (!ep) throw new ContentUnavailableError(externalId);
    return ep;
  }

  // ----- helpers Melolo (struktur lengkap belum ada sample → normalisasi defensif) -----

  /**
   * Feed Melolo. PARAM: `offset` untuk foryou/anime (pagination), tanpa offset untuk
   * latest/trending. Cache per endpoint; sekaligus di-persist ke tabel dramas (DB-first).
   */
  private async meloloFeed(
    endpoint: 'foryou' | 'trending' | 'anime' | 'latest',
    cacheKey: string,
    feedType: string,
    page: string,
    ttl: number,
    moduleType: string,
  ): Promise<FeedEnvelope> {
    const params: Record<string, string> = {};
    if (endpoint === 'foryou' || endpoint === 'anime') params.offset = page || '0';
    const raw = await cacheService.getOrFetch<MeloloObject | undefined>(
      cacheKey,
      endpoint,
      ttl,
      async () => (await externalApiService.request<MeloloObject | undefined>('melolo', endpoint, params)).data,
      params,
      'melolo',
    );
    const items = this.meloloItems(raw)
      .filter((it) => !!meloloId(it))
      .map((it) => this.meloloItemToSummary(it, moduleType, endpoint));
    const next = this.meloloFeedNext(page, raw);
    this.persistFeed('melolo', items, endpoint, moduleType, feedType);
    return { page_info: { next, has_more: !!next }, items };
  }

  /** Home Melolo = gabungan latest + trending + anime (3 endpoint, tanpa pagination lanjutan). */
  private async meloloHome(): Promise<FeedEnvelope> {
    const sections = await Promise.all(
      (['latest', 'trending', 'anime'] as const).map(async (endpoint) => {
        const feed = await this.meloloFeed(endpoint, `melolo:${endpoint}`, 'homepage', '', config.HOMEPAGE_TTL, endpoint);
        return {
          endpoint,
          items: feed.items.map((it) => ({ ...it, moduleKey: endpoint, moduleType: endpoint })),
        };
      }),
    );
    const seen = new Set<string>();
    const items: DramaSummary[] = [];
    for (const section of sections) {
      for (const it of section.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
    this.persistFeed('melolo', items, undefined, undefined, 'home');
    return { page_info: { next: '', has_more: false }, items };
  }

  /** Token next Melolo: `data.cell` / `data` memakai `has_more` + `next_offset`. */
  private meloloFeedNext(pageToken: string, raw: MeloloObject | undefined): string {
    if (!raw) return '';
    const cell = raw.cell && typeof raw.cell === 'object' ? (raw.cell as MeloloObject) : undefined;
    const node = cell ?? raw;
    const hasMore = meloloPickUnknown(node, ['has_more', 'hasMore', 'has_next', 'hasNext']);
    if (hasMore === false || hasMore === 0 || hasMore === 'false' || hasMore === '0') return '';
    const cur = meloloPickUnknown(node, ['next_offset', 'nextOffset', 'next_cursor', 'next', 'cursor']);
    if (typeof cur === 'number' && String(cur) !== pageToken) return String(cur);
    if (typeof cur === 'string' && cur && cur !== pageToken) return cur;
    return '';
  }

  /**
   * Ekstrak daftar `books` dari response Melolo. Buku tersarang di kedalaman
   * berbeda per endpoint: `data.cell.cell_data[].books`, `data.cells[].cell_data[].books`,
   * `data.search_data[].books` → scan rekursif semua kunci "books" (dedup by book_id).
   */
  private meloloItems(raw: MeloloObject | undefined): MeloloObject[] {
    const out: MeloloObject[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'books' && Array.isArray(v)) {
          for (const b of v) {
            if (!b || typeof b !== 'object') continue;
            const obj = b as MeloloObject;
            const id = meloloId(obj);
            if (id && !seen.has(id)) {
              seen.add(id);
              out.push(obj);
            }
          }
        } else {
          walk(v);
        }
      }
    };
    walk(raw);
    return out;
  }

  private meloloItemToSummary(it: MeloloObject, moduleType?: string, moduleKey?: string): DramaSummary {
    return {
      id: meloloId(it),
      title: meloloPick(it, ['book_name', 'title', 'series_title', 'name'], ''),
      cover: meloloPick(it, ['thumb_url', 'first_chapter_cover', 'series_cover', 'cover', 'image'], ''),
      description: meloloPick(it, ['abstract', 'series_intro', 'description', 'desc', 'sinopsis'], ''),
      tags: meloloTags(it),
      moduleType,
      moduleKey,
    };
  }

  /**
   * Daftar episode dari `data.video_data.video_list` (detail Melolo).
   * Stream belum ada di list → diambil per episode via endpoint `episode` (videoId).
   */
  private meloloDetailEpisodes(vd: MeloloObject | undefined): EpisodeSummary[] {
    const list = vd && Array.isArray(vd.video_list) ? (vd.video_list as MeloloObject[]) : [];
    if (list.length === 0) return [];
    return list
      .filter((it) => !!meloloPickUnknown(it, ['vid']))
      .map((it) => {
        const vid = String(meloloPickUnknown(it, ['vid']));
        const index = Number(meloloPickUnknown(it, ['vid_index']) ?? 0) || 0;
        return {
          id: vid,
          number: index,
          title: `Episode ${index}`,
          cover: meloloPick(it, ['episode_cover', 'cover'], ''),
          streamUrl: meloloStreamUrl(it),
          subtitles: [],
        };
      });
  }

  /**
   * Stream episode Melolo: cari `vid` episode itu dari detail (cache), lalu panggil
   * endpoint `episode` dengan `videoId`. Fallback: inline stream bila ada.
   */
  private async meloloEpisodeStream(externalId: string, episodeNum: number): Promise<string> {
    const detail = await cacheService.getOrFetch<MeloloObject | undefined>(
      `melolo:detail:${externalId}`,
      'detail',
      config.DETAIL_TTL,
      async () => (await externalApiService.request<MeloloObject | undefined>('melolo', 'detail', { book_id: externalId })).data,
      { book_id: externalId },
      'melolo',
    );
    const vd = detail && typeof detail.video_data === 'object' ? (detail.video_data as MeloloObject) : undefined;
    const list = vd && Array.isArray(vd.video_list) ? (vd.video_list as MeloloObject[]) : [];
    const target = list[episodeNum - 1];
    let videoId: string = '';
    if (target) {
      const inline = meloloStreamUrl(target);
      if (inline) return inline;
      const vid = meloloPickUnknown(target, ['vid', 'video_id', 'videoId']);
      if (typeof vid === 'string' || typeof vid === 'number') videoId = String(vid);
    } else if (vd) {
      const vid = meloloPickUnknown(vd, ['video_id', 'videoId']);
      if (typeof vid === 'string' || typeof vid === 'number') videoId = String(vid);
    }
    if (!videoId) return '';
    const raw = await cacheService.getOrFetch<MeloloObject | undefined>(
      `melolo:episode:${videoId}`,
      'get-episode',
      config.DETAIL_TTL,
      async () => (await externalApiService.request<MeloloObject | undefined>('melolo', 'get-episode', { videoId })).data,
      { videoId },
      'melolo',
    );
    return meloloStreamUrl(raw) || '';
  }

  // ----- helpers MovieBox (dari CONTOHEXECUTE/moviebox — SOURCE OF TRUTH) -----

  /**
   * Home MovieBox = 3 kategori yang ditampilkan di beranda mobile
   * (k-drama, hollywood-movies, indo-movies). Masing-masing di-cache terpisah.
   */
  private async movieboxHome(): Promise<FeedEnvelope> {
    const categories: Array<{ endpoint: string; label: string }> = [
      { endpoint: 'k-drama', label: 'k-drama' },
      { endpoint: 'hollywood-movies', label: 'hollywood-movies' },
      { endpoint: 'indo-movies', label: 'indo-movies' },
    ];
    const sections = await Promise.all(
      categories.map(async ({ endpoint, label }) => {
        const raw = await cacheService.getOrFetch<MovieBoxFeed>(
          `moviebox:${endpoint}`,
          endpoint,
          config.HOMEPAGE_TTL,
          async () => (await externalApiService.request<MovieBoxFeed>('moviebox', endpoint, { page: '1' })).data,
          { page: '1' },
          'moviebox',
        );
        const items = (raw?.items ?? [])
          .filter((it) => !!it?.subjectId)
          .map((it) => this.movieBoxSubjectToSummary(it, label, label));
        this.persistFeed('moviebox', items, undefined, label, endpoint);
        return items;
      }),
    );
    const seen = new Set<string>();
    const items: DramaSummary[] = [];
    for (const section of sections) {
      for (const it of section) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
    this.persistFeed('moviebox', items, undefined, undefined, 'home');
    return { page_info: { next: '', has_more: false }, items };
  }

  /**
   * Detail MovieBox — SATU panggilan `detail?subjectId=X` (tanpa param season;
   * langganan memakai season hanya sebagai metadata). Upstream tidak menyertakan
   * daftar episode → di-synthesize berurutan 1..maxEp(season 1); stream per episode
   * di-resolve saat pemutaran lewat `get-download-url`. Untuk seri multi-season,
   * daftar hanya Season 1 (info season lain tetap via `seasons`). Episode yang
   * benar-benar inline (bila ada) menimpa entri tersintesis dengan nomor sama.
   * Film (tanpa metadata season) → 1 episode.
   */
  private async movieboxDetail(externalId: string): Promise<DramaDetail> {
    const raw = await cacheService.getOrFetch<MovieBoxObject>(
      `moviebox:detail:v2:${externalId}`,
      'detail',
      config.DETAIL_TTL,
      async () => (await externalApiService.request<MovieBoxObject>('moviebox', 'detail', { subjectId: externalId })).data,
      { subjectId: externalId },
      'moviebox',
    );
    const obj = raw && typeof raw === 'object' ? raw : undefined;
    const subjectId = movieBoxPick(obj, ['subjectId'], '');
    if (!subjectId && !movieBoxPick(obj, ['title'], '')) throw new ContentUnavailableError(externalId);
    const seasons = this.movieBoxSeasons(obj);
    const realEpisodes = movieBoxSeasonEpisodes(obj, subjectId, 1);
    const byNum = new Map<number, EpisodeSummary>();
    for (const ep of realEpisodes) byNum.set(ep.number, ep);
    const totalResource = movieBoxTotalEpisode(obj);
    const season1Count =
      seasons.length > 0
        ? (seasons[0].maxEp ?? 0)
        : totalResource > 0
          ? totalResource
          : 1;
    const count = Math.max(1, Math.min(season1Count, MAX_MOVIEBOX_EPISODES));
    const cover = movieBoxCover(obj);
    const episodes: EpisodeSummary[] = [];
    for (let n = 1; n <= count; n++) {
      const real = byNum.get(n);
      if (real) {
        episodes.push(real);
      } else {
        episodes.push({
          id: `${subjectId}:se1ep${n}`,
          number: n,
          title: `Episode ${n}`,
          cover,
          streamUrl: '',
          subtitles: [],
        });
      }
    }
    const detail: DramaDetail = {
      id: subjectId || externalId,
      title: movieBoxPick(obj, ['title'], ''),
      cover,
      description: movieBoxPick(obj, ['description', 'intro', 'abstract'], ''),
      tags: movieBoxTags(obj),
      episodeCount: episodes.length,
      episodes,
      seasons: seasons.map((se) => ({ number: se.se, episodeCount: se.maxEp ?? 0 })),
    };
    await this.persistDetail('moviebox', detail, 'detail').catch((err) => {
      console.warn('[provider:moviebox] Simpan detail drama gagal (dilewati):', (err as Error).message);
    });
    return detail;
  }

  private movieBoxSeasons(obj: MovieBoxObject | undefined): MovieBoxSeason[] {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.seasons)) return [];
    const out: MovieBoxSeason[] = [];
    for (const item of obj.seasons) {
      if (!item || typeof item !== 'object') continue;
      const o = item as MovieBoxObject;
      const seV = movieBoxPickUnknown(o, ['se', 'season', 'seasonNumber']);
      const se = typeof seV === 'number' ? seV : typeof seV === 'string' ? Number(seV) : NaN;
      if (!Number.isFinite(se)) continue;
      const maxEpV = movieBoxPickUnknown(o, ['maxEp', 'max_ep', 'epCount', 'episodeCount', 'totalEpisodes', 'episode_cnt']);
      const maxEp = typeof maxEpV === 'number' ? maxEpV : typeof maxEpV === 'string' ? Number(maxEpV) : NaN;
      out.push({ se: Math.floor(se), maxEp: Number.isFinite(maxEp) ? Math.floor(maxEp) : 0 });
    }
    return out.sort((a, b) => a.se - b.se);
  }

  /**
   * Bangun URL stream MovieBox yang bisa diputar oleh mobile:
   * 1. `proxy-video?url=<raw>` → `download_url` (`cdn-proxy` di domain upstream).
   * 2. Rewire host `download_url` → domain backend kita (agar mobile tetap
   *    hanya mengakses backend). Cache per episode supaya tidak memanggil
   *    proxy-video berulang kali.
   * 3. Gagal proxy-video → fallback `cdn-proxy` langsung dari rawUrl di domain kita.
   */
  private async movieboxPlayUrl(externalId: string, episodeNum: number, rawUrl: string, signCookie?: string, requestOrigin?: string): Promise<string> {
    // Base URL stream harus domain yang SAMA dengan request masuk (host HP ke backend),
    // bukan localhost/config — kalau tidak player mobile tidak bisa menjangkau cdn-proxy.
    const selfBase = requestOrigin ?? config.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const buildProxy = (target: string, cookie?: string) => {
      let url = `${selfBase}/api/moviebox/cdn-proxy?url=${encodeURIComponent(target)}`;
      if (cookie) url += `&c=${encodeURIComponent(cookie)}`;
      return url;
    };
    // Proxy-video (alur resmi app moviebox) → `download_url` (`cdn-proxy` di domain upstream).
    // Kita rewire host ke domain kita.
    try {
      const proxy = await cacheService.getOrFetch<MovieBoxProxyVideo>(
        `moviebox:proxy:${externalId}:${episodeNum}`,
        'proxy-video',
        config.DETAIL_TTL,
        async () =>
          (
            await externalApiService.request<MovieBoxProxyVideo>('moviebox', 'proxy-video', {
              url: rawUrl,
            })
          ).data,
        { url: rawUrl },
        'moviebox',
      );
      if (proxy && typeof proxy.download_url === 'string' && proxy.download_url.startsWith('http')) {
        try {
          const u = new URL(proxy.download_url);
          const selfHost = new URL(selfBase).host;
          if (u.host !== selfHost) u.host = selfHost;
          // Pastikan ada param c (cookie) dari asal proxy-video (download_url asli tidak mengandungnya)
          if (signCookie && !u.searchParams.has('c')) u.searchParams.set('c', signCookie);
          return u.toString();
        } catch {
          // download_url parse gagal — fallback
        }
      }
    } catch {
      // proxy-video mungkin gagal (404/mati); fallback langsung.
    }
    // Fallback: bicara langsung ke CDN (sacdn) dengan cookie server-side.
    return buildProxy(rawUrl, signCookie);
  }

  /**
   * Film MovieBox (subjectType=1, season=0) TIDAK disajikan get-download-url
   * (endpoint itu khusus seri). Stream asli film ada di
   * `detail.resourceDetectors[].resolutionList[].resourceLink` — MP4 di
   * `bcdn.hakunaymatata.com` dengan `?sign=&t=` (signed query, tanpa Cookie).
   * Ambil resolusi tertinggi lalu bungkus lewat `cdn-proxy` di domain kita.
   */
  private async movieboxFilmEpisode(externalId: string, episodeNum: number, requestOrigin?: string): Promise<EpisodeSummary | undefined> {
    try {
      const obj = await cacheService.getOrFetch<MovieBoxObject>(
        `moviebox:detail:v2:${externalId}`,
        'detail',
        config.DETAIL_TTL,
        async () => (await externalApiService.request<MovieBoxObject>('moviebox', 'detail', { subjectId: externalId })).data,
        { subjectId: externalId },
        'moviebox',
      );
      if (!obj || typeof obj !== 'object') return undefined;
      if (movieBoxPick(obj, ['subjectType'], '') !== '1') return undefined;
      const found: Array<{ resolution: number; link: string; h264: boolean }> = [];
      const rds = Array.isArray(obj.resourceDetectors) ? obj.resourceDetectors : [];
      for (const rd of rds) {
        if (!rd || typeof rd !== 'object') continue;
        const list = (rd as MovieBoxObject).resolutionList;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const o = item as MovieBoxObject;
          const link = movieBoxPickUnknown(o, ['resourceLink', 'downloadUrl', 'url']);
          if (typeof link !== 'string' || !/^https:\/\//.test(link)) continue;
          const resV = movieBoxPickUnknown(o, ['resolution', 'vid']);
          const resolution = typeof resV === 'number' ? resV : typeof resV === 'string' ? Number(resV) : 0;
          const codecV = movieBoxPickUnknown(o, ['codecName', 'codec']);
          const h264 =
            (typeof codecV === 'string' && /h264|avc/i.test(codecV)) || /\/h264\//i.test(link);
          found.push({ resolution: Number.isFinite(resolution) ? resolution : 0, link, h264 });
        }
      }
      if (!found.length) return undefined;
      // Satu varian per resolusi (utamakan h264 agar kompatibel lebih luas).
      const byRes = new Map<number, { resolution: number; link: string; h264: boolean }>();
      for (const it of found) {
        const prev = byRes.get(it.resolution);
        if (!prev || (it.h264 && !prev.h264)) byRes.set(it.resolution, it);
      }
      const list = [...byRes.values()].sort((a, b) => b.resolution - a.resolution);
      const selfBase = requestOrigin ?? config.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const toProxyUrl = (link: string) => `${selfBase}/api/moviebox/cdn-proxy?url=${encodeURIComponent(link)}`;
      const variants = list.map((v) => ({
        id: v.resolution ? `${v.resolution}p` : 'std',
        label: v.resolution ? `${v.resolution}p` : 'Standar',
        resolution: v.resolution || null,
        url: toProxyUrl(v.link),
      }));
      const best = list[0];
      return {
        id: `${externalId}:se1ep${episodeNum}`,
        number: episodeNum,
        title: movieBoxPick(obj, ['title'], `Episode ${episodeNum}`),
        cover: movieBoxCover(obj),
        streamUrl: toProxyUrl(best.link),
        subtitles: [],
        variants,
      };
    } catch (err) {
      console.warn(`[moviebox] Film fallback gagal ${externalId}:${episodeNum} :: ${(err as Error).message}`);
      return undefined;
    }
  }

  private movieBoxSubjectToSummary(s: MovieBoxSubject, moduleType?: string, moduleKey?: string): DramaSummary {
    return {
      id: String(s.subjectId ?? ''),
      title: s.title ?? '',
      cover: movieBoxPick(s.cover as MovieBoxObject | undefined, ['url'], '') || movieBoxPick(s as unknown as MovieBoxObject, ['cover', 'coverUrl', 'poster', 'posterUrl'], ''),
      description: s.description ?? '',
      tags: movieBoxTags(s as unknown as MovieBoxObject),
      moduleType,
      moduleKey,
    };
  }

  // ----- helpers FreeReels (struktur lama) -----

/** Simpan detail drama + episode ke DB (favorites/watch-history/continue-watching). */
  private async persistDetail(provider: DramaProviderId, detail: DramaDetail, feedType: string): Promise<void> {
    const slug =
      detail.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || `id-${detail.id}`;
    const now = new Date();
    const existing = await prisma.drama.findUnique({
      where: { provider_externalId: { provider, externalId: detail.id } },
      select: { id: true, expiresAt: true, totalEpisodes: true },
    });
    // Lewati tulis ulang bila data sudah segar & jumlah episode sama (hemat round-trip DB).
    if (existing && existing.expiresAt && existing.expiresAt > now && existing.totalEpisodes === detail.episodeCount) {
      return;
    }
    const externalData: Prisma.InputJsonValue = { provider, cachedEpisodes: detail.episodes.length };
    const drama = await prisma.drama.upsert({
      where: { provider_externalId: { provider, externalId: detail.id } },
      create: {
        provider,
        externalId: detail.id,
        title: detail.title,
        slug,
        description: detail.description,
        posterUrl: detail.cover,
        coverUrl: detail.cover,
        category: feedType,
        type: detail.episodeCount > 0 ? 'series' : feedType,
        totalEpisodes: detail.episodeCount,
        externalData,
        cachedAt: now,
        expiresAt: new Date(Date.now() + config.DETAIL_TTL * 1000),
        lastFetchedAt: now,
        lastRefreshStatus: 'ok',
        refreshAttempt: 0,
      },
      update: {
        title: detail.title,
        slug,
        description: detail.description,
        posterUrl: detail.cover,
        coverUrl: detail.cover,
        totalEpisodes: detail.episodeCount,
        externalData,
      },
    });
    // Insert massal episode baru (skip yang sudah ada); update detail hanya bila sudah punya data stream/cover.
    await prisma.episode.createMany({
      data: detail.episodes.map((ep) => ({
        dramaId: drama.id,
        externalEpId: ep.id,
        episodeNumber: ep.number,
        title: ep.title,
        thumbnailUrl: ep.cover || null,
        videoUrl: ep.streamUrl || null,
        subtitleList: ep.subtitles.length ? (ep.subtitles as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      })),
      skipDuplicates: true,
    });
    for (const ep of detail.episodes.filter((e) => !!e.streamUrl || !!e.cover)) {
      await prisma.episode.updateMany({
        where: { dramaId: drama.id, externalEpId: ep.id },
        data: {
          title: ep.title,
          thumbnailUrl: ep.cover || null,
          videoUrl: ep.streamUrl || null,
        },
      });
    }
  }

  /** Simpan ringkasan feed ke tabel dramas agar DB-first search bekerja antar provider. */
  private persistFeed(
    provider: DramaProviderId,
    items: DramaSummary[],
    moduleKey: string | undefined,
    moduleType: string | undefined,
    feedType: string,
  ): void {
    void upsertDramasFromFeed(
      provider,
      items.map((it) => ({ key: it.id, title: it.title, cover: it.cover, desc: it.description })),
      moduleType,
      moduleKey,
      feedType,
    ).catch((err) => {
      console.warn(`[provider:${provider}] Upsert drama dari feed gagal (dilewati):`, (err as Error).message);
    });
  }

  private async freereelsFeed(
    endpoint: 'foryou' | 'homepage' | 'animepage',
    cacheKey: string,
    feedType: string,
    page: string,
    ttl: number,
  ): Promise<FeedEnvelope> {
    const params: Record<string, string> = {};
    if (page) params.page = page;
    const raw = await cacheService.getOrFetch<RawFreeReelsFeed>(
      cacheKey,
      endpoint,
      ttl,
      async () => (await externalApiService.request<RawFreeReelsFeed>('freereels', endpoint, params)).data,
      params,
      'freereels',
    );
    const items: DramaSummary[] = [];
    const seen = new Set<string>();
    for (const row of raw?.items ?? []) {
      const module = row as { items?: unknown[] };
      if (Array.isArray(module.items)) {
        for (const inner of module.items) {
          const it = inner as FreereelsFeedItem;
          if (!it?.key || seen.has(it.key)) continue;
          seen.add(it.key);
          items.push(this.freereelsItemToSummary(it, feedType));
        }
      } else {
        const it = row as FreereelsFeedItem;
        if (!it?.key || seen.has(it.key)) continue;
        seen.add(it.key);
        items.push(this.freereelsItemToSummary(it, feedType));
      }
    }
const pageInfo = raw?.page_info ?? {};
    const nextRaw = pageInfo.next_page || pageInfo.next || '';
    // Cegah loop: upstream freereels kadang membalas token next yang SAMA dengan token yang
    // baru dipakai (mis. "offset=30&position_index=10000") → anggap sebagai halaman terakhir.
    const next = page && nextRaw === page ? '' : nextRaw;
    const hasMore = !!next;
    this.persistFeed('freereels', items, undefined, feedType, feedType);
    return {
      page_info: { next, has_more: hasMore },
      items,
    };
  }

  private freereelsItemToSummary(it: FreereelsFeedItem, moduleType?: string, moduleKey?: string): DramaSummary {
    return {
      id: it.key,
      title: it.title ?? '',
      cover: it.cover ?? '',
      description: it.desc ?? '',
      tags: [...(it.tag ?? []), ...(it.series_tag ?? [])],
      moduleType,
      moduleKey,
    };
  }

  private async freereelsDetail(externalId: string): Promise<DramaDetail> {
    const raw = await cacheService.getOrFetch<{ info?: FreereelsDetailInfo }>(
      `freereels:detailAndAllEpisode:${externalId}`,
      'detailAndAllEpisode',
      config.DETAIL_TTL,
      async () => (await externalApiService.request<{ info?: FreereelsDetailInfo }>('freereels', 'detailAndAllEpisode', { key: externalId })).data,
      { key: externalId },
      'freereels',
    );
    const info = raw?.info;
    if (!info?.id) throw new ContentUnavailableError(externalId);
    const episodes = (info.episode_list ?? []).map((ep, i) => ({
      id: ep.id,
      number: i + 1,
      title: ep.name ?? '',
      cover: ep.cover ?? '',
      streamUrl: pickFreereelsStream(ep),
      subtitles: (ep.subtitle_list ?? [])
        .filter((s) => !!s.subtitle)
        .map((s) => ({ language: s.language, displayName: s.display_name ?? s.language, url: s.subtitle ?? '' })),
    }));
    const detail: DramaDetail = {
      id: info.id,
      title: info.name ?? '',
      cover: info.cover ?? '',
      description: info.desc ?? '',
      tags: [...(info.tag ?? []), ...(info.series_tag ?? [])],
      episodeCount: episodes.length,
      episodes,
    };
    await this.persistDetail('freereels', detail, 'detail').catch((err) => {
      console.warn('[provider:freereels] Simpan detail drama gagal (dilewati):', (err as Error).message);
    });
    return detail;
  }
}

interface FreereelsFeedItem {
  key: string;
  title?: string;
  cover?: string;
  desc?: string;
  tag?: string[];
  series_tag?: string[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Bentuk raw Melolo (dari CONTOHEXECUTE/melolo/):
// - feed: data.cell.cell_data[].books[], data.cells[].cell_data[].books[],
//   data.search_data[].books[]; pagination data.has_more + data.next_offset.
// - detail: data.video_data.{series_id_str, series_title, series_intro,
//   series_cover, episode_cnt, video_list[]} — episode pakai vid/vid_index.
// - episode: top-level streamUrl (720p) + qualities[].streamUrl.
// ---------------------------------------------------------------------------

type MeloloObject = Record<string, unknown>;

/** Ambil nilai (unknown) dari kandidat field pertama yang ada. */
function meloloPickUnknown(obj: MeloloObject | undefined, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Ambil string dari kandidat field (hilangkan whitespace kosong). */
function meloloPick(obj: MeloloObject | undefined, keys: string[], fallback: string): string {
  const v = meloloPickUnknown(obj, keys);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

/** Id drama/episode Melolo: `book_id` (feed) / `series_id_str` (detail) / `vid` (episode). */
function meloloId(obj: MeloloObject | undefined): string {
  const v = meloloPickUnknown(obj, ['book_id', 'bookId', 'series_id_str', 'vid', 'video_id', 'videoId', 'id', 'collection_id']);
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** Tag/kategori: parse JSON string `category_info`/`category_schema` (array {Name/name}). */
function meloloTags(obj: MeloloObject | undefined): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const cat = meloloPickUnknown(obj, ['category_info', 'category_schema']);
  if (typeof cat === 'string' && cat) {
    try {
      const arr: unknown = JSON.parse(cat);
      if (Array.isArray(arr)) {
        const names = arr
          .filter((x): x is MeloloObject => !!x && typeof x === 'object')
          .map((x) => meloloPick(x, ['Name', 'name'], ''))
          .filter(Boolean);
        if (names.length) return names;
      }
    } catch {
      // lanjut ke kandidat lain
    }
  }
  const v = meloloPickUnknown(obj, ['tag', 'tags', 'categories', 'genre']);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Jumlah episode dari field angka (`episode_cnt` di video_data), fallback ke hitungan daftar episode. */
function meloloCount(obj: MeloloObject | undefined, fallback: number): number {
  const v = meloloPickUnknown(obj, ['episode_cnt', 'episode_count', 'total_episodes', 'episodes_count', 'videos_count', 'total']);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Stream video Melolo: pilih kualitas H.264 tertinggi dari `qualities[]`, lalu
 * top-level `streamUrl`, terakhir kualitas pertama.
 */
function meloloStreamUrl(obj: MeloloObject | undefined): string {
  if (!obj || typeof obj !== 'object') return '';
  const qs: MeloloObject[] = Array.isArray(obj.qualities) ? (obj.qualities as MeloloObject[]) : [];
  if (qs.length > 0) {
    const heightOf = (q: MeloloObject): number => {
      const parts = String(q.resolution ?? '').split('x');
      const h = Number(parts[1] ?? parts[0]);
      return Number.isFinite(h) ? h : 0;
    };
    const byQuality = (a: MeloloObject, b: MeloloObject): number => heightOf(b) - heightOf(a);
    const h264 = qs
      .filter((q) => typeof q.codec === 'string' && q.codec.toLowerCase().includes('h264'))
      .sort(byQuality);
    const best = h264[0] ?? qs.slice().sort(byQuality)[0];
    const url = best && typeof best.streamUrl === 'string' ? best.streamUrl : '';
    if (url) return url;
  }
  const top = meloloPickUnknown(obj, ['streamUrl', 'external_audio_h264_m3u8', 'external_audio_h265_m3u8', 'm3u8_url', 'stream_url']);
  return typeof top === 'string' ? top : '';
}

interface RawFreeReelsFeed {
  page_info?: { next?: string; next_page?: string; has_more?: boolean };
  items?: Array<Record<string, unknown>>;
}

interface FreereelsDetailInfo {
  id: string;
  name?: string;
  desc?: string;
  cover?: string;
  tag?: string[];
  series_tag?: string[];
  episode_list?: Array<{
    id: string;
    name?: string;
    cover?: string;
    video_url?: string;
    m3u8_url?: string;
    external_audio_h264_m3u8?: string;
    external_audio_h265_m3u8?: string;
    subtitle_list?: Array<{ language: string; display_name?: string; subtitle?: string }>;
  }>;
}

function pickFreereelsStream(ep: NonNullable<FreereelsDetailInfo['episode_list']>[number]): string {
  return ep.external_audio_h264_m3u8 || ep.external_audio_h265_m3u8 || ep.m3u8_url || ep.video_url || '';
}

// ---------------------------------------------------------------------------
// Bentuk raw MovieBox (dari CONTOHEXECUTE/moviebox — SOURCE OF TRUTH):
// - kategori (k-drama / hollywood-movies / indo-movies): data.pager + data.items[]
// - search: data.pager + data.results[].subjects[]
// - detail tanpa season (= 0): metadata + data.seasons[] (daftar season);
// - stream episode: `get-download-url?subjectId=&episode=&season=` →
//   data.streams[0].url (+ signCookie CloudFront via header Cookie) + data.subtitles[].
// - id drama = data.subjectId (string unik).
// ---------------------------------------------------------------------------

/** Batas daftar episode tersintesis MovieBox (seri sangat panjang dibatasi). */
const MAX_MOVIEBOX_EPISODES = 500;

interface MovieBoxStream {
  streams?: Array<{
    format?: string;
    id?: string;
    url?: string;
    resolutions?: string;
    size?: string;
    duration?: number;
    codecName?: string;
    signCookie?: string;
    idType?: string;
  }>;
  title?: string;
  cdnThrottleLevel?: number;
  subtitles?: Array<{
    id?: string;
    lan?: string;
    lanName?: string;
    url?: string;
    size?: string;
    delay?: number;
  }>;
}

interface MovieBoxProxyVideo {
  download_url?: string;
}

interface MovieBoxPager {
  hasMore?: boolean;
  nextPage?: string;
  page?: string;
  perPage?: number;
  totalCount?: number;
}

interface MovieBoxSubject {
  subjectId?: string;
  title?: string;
  description?: string;
  genre?: string;
  releaseDate?: string;
  cover?: { url?: string } | null;
  countryName?: string;
  language?: string;
  imdbRatingValue?: string;
  seNum?: number;
  detailUrl?: string;
  [k: string]: unknown;
}

interface MovieBoxFeed {
  pager?: MovieBoxPager;
  items?: MovieBoxSubject[];
}

interface MovieBoxSearch {
  pager?: MovieBoxPager;
  results?: Array<{ topicType?: string; subjects?: MovieBoxSubject[] }>;
}

interface MovieBoxSeason {
  se: number;
  maxEp?: number;
  allEp?: string;
}

type MovieBoxObject = Record<string, unknown>;

function movieBoxPickUnknown(obj: MovieBoxObject | undefined, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function movieBoxPick(obj: MovieBoxObject | undefined, keys: string[], fallback: string): string {
  const v = movieBoxPickUnknown(obj, keys);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return fallback;
}

/** Cover MovieBox: `cover.url` (objek) atau field string fallback. */
function movieBoxCover(obj: MovieBoxObject | undefined): string {
  const direct = movieBoxPick(obj, ['cover', 'coverUrl', 'poster', 'posterUrl', 'image', 'thumb', 'thumbnail'], '');
  if (direct) return direct;
  if (!obj || typeof obj !== 'object') return '';
  const cover = obj.cover;
  if (cover && typeof cover === 'object') {
    const url = movieBoxPick(cover as MovieBoxObject, ['url'], '');
    if (url) return url;
  }
  return '';
}

/** Tag MovieBox: genre (koma) + negara. */
function movieBoxTags(obj: MovieBoxObject | undefined): string[] {
  const out: string[] = [];
  const genre = movieBoxPick(obj, ['genre'], '');
  if (genre) out.push(...genre.split(',').map((s) => s.trim()).filter(Boolean));
  const country = movieBoxPick(obj, ['countryName'], '');
  if (country) out.push(country);
  return out;
}

/** Total episode dari `resourceDetectors[].totalEpisode` (jumlah seluruh resource). */
function movieBoxTotalEpisode(obj: MovieBoxObject | undefined): number {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.resourceDetectors)) return 0;
  let sum = 0;
  for (const rd of obj.resourceDetectors) {
    if (!rd || typeof rd !== 'object') continue;
    const v = movieBoxPickUnknown(rd as MovieBoxObject, ['totalEpisode', 'total_episodes', 'episodeCount']);
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) sum += Math.floor(n);
  }
  return sum;
}

/** Stream URL dari satu objek (kandidat field url + nested playUrl/qualities), hanya video. */
function movieBoxStreamOf(obj: MovieBoxObject | undefined): string {
  const isVideo = (u: unknown): u is string => {
    if (typeof u !== 'string' || !u.startsWith('http')) return false;
    const path = u.split('?')[0].split('#')[0].toLowerCase();
    return /\.(m3u8|mp4|mkv|webm|ts)(\?|$)/.test(path) || path.includes('.m3u8');
  };
  if (!obj || typeof obj !== 'object') return '';
  const url = movieBoxPickUnknown(obj, [
    'external_audio_h264_m3u8',
    'external_audio_h265_m3u8',
    'h264M3u8Url',
    'm3u8Url',
    'm3u8_url',
    'streamUrl',
    'stream_url',
    'videoUrl',
    'video_url',
    'playUrl',
    'play_url',
    'downloadUrl',
    'url',
  ]);
  if (isVideo(url)) return url;
  const play = obj.playUrl;
  if (play && typeof play === 'object') {
    const inner = movieBoxStreamOf(play as MovieBoxObject);
    if (inner) return inner;
  }
  const qs = obj.qualities;
  if (Array.isArray(qs)) {
    for (const q of qs) {
      if (q && typeof q === 'object') {
        const inner = movieBoxStreamOf(q as MovieBoxObject);
        if (inner) return inner;
      }
    }
  }
  return '';
}

/** Nomor episode dari kandidat field angka dalam objek episode. */
function movieBoxEpisodeNum(obj: MovieBoxObject): number {
  const v = movieBoxPickUnknown(obj, ['epNum', 'episodeNum', 'episode_number', 'episode', 'num', 'vidIndex', 'vid_index', 'order']);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * Ekstrak daftar episode dari response `detail?subjectId=X` (tanpa param season).
 * STRICT: objek dianggap episode hanya jika punya nomor episode POSITIF dan
 * (id episode ATAU stream video nyata). Host inline upstream; konten luar yang
 * dirujuk `resourceLink` TIDAK disertakan. Dedup by id+stream.
 */
function movieBoxSeasonEpisodes(raw: MovieBoxObject | undefined, subjectId: string, season: number): EpisodeSummary[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: EpisodeSummary[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as MovieBoxObject;
    const num = movieBoxEpisodeNum(o);
    const stream = movieBoxStreamOf(o);
    const epId = movieBoxPick(o, ['epId', 'episodeId', 'videoId', 'resourceId', 'vid', 'id'], '');
    if (num > 0 && (epId || stream)) {
      const key = `${epId}:${stream}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          id: epId || `${subjectId || raw.subjectId || ''}:se${season}ep${num}`,
          number: num,
          title: movieBoxPick(o, ['epTitle', 'title', 'name'], `Episode ${num}`),
          cover: movieBoxCover(o),
          streamUrl: stream,
          subtitles: [],
        });
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(raw);
  out.sort((a, b) => a.number - b.number);
  return out;
}

export const providerService = new ProviderService();