/**
 * Konversi antar bentuk: API eksternal/fixture ↔ JSON respons internal ↔ DB.
 * Mapping drama (field "key") dan episode (stream asli di external_audio_*_m3u8).
 */
import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';

/** Konversi ke JSON yang diterima kolom Prisma json (nullable). */
function asJson(v: unknown): Prisma.InputJsonValue {
  return (v ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue;
}

export interface DramaSummary {
  id: string;
  title: string;
  cover: string;
  description: string;
  tags: string[];
  moduleKey?: string;
  moduleType?: string;
}

export interface EpisodeSummary {
  id: string;
  number: number;
  title: string;
  cover: string;
  streamUrl: string;
  subtitles: { language: string; displayName: string; url: string }[];
  /** Header tambahan saat memuat stream (mis. `Cookie` CloudFront signed). */
  requestHeaders?: Record<string, string>;
  /**
   * Varian resolusi alternatif (mis. film MovieBox MP4 per kualitas).
   * Dipakai player untuk tombol pilih kualitas / mode lancap.
   */
  variants?: { id: string; label: string; resolution: number | null; url: string }[];
}

export interface DramaDetail extends DramaSummary {
  episodeCount: number;
  episodes: EpisodeSummary[];
  seasons?: { number: number; episodeCount: number }[];
}

export interface FeedEnvelope {
  page_info: { next: string; has_more: boolean };
  items: DramaSummary[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Item drama mentah dari feed (homepage/anime/foryou). */
export interface FeedItem {
  key: string;
  title: string;
  cover: string;
  desc: string;
  tag?: string[];
  series_tag?: string[];
}

/** Info detail mentah dari detailAndAllEpisode. */
export interface DetailInfo {
  id: string;
  name: string;
  desc?: string;
  cover: string;
  episode_count?: number;
  view_count?: number;
  follow_count?: number;
  finish_status?: number;
  tag?: string[];
  series_tag?: string[];
  episode_list?: RawEpisode[];
}

interface RawEpisode {
  id: string;
  name: string;
  cover: string;
  video_url: string;
  m3u8_url: string;
  external_audio_h264_m3u8: string;
  external_audio_h265_m3u8: string;
  subtitle_list?: { language: string; display_name?: string; subtitle: string }[];
}

export type { RawEpisode };

function pickStreamUrl(ep: RawEpisode): string {
  return ep.external_audio_h264_m3u8 || ep.external_audio_h265_m3u8 || ep.m3u8_url || ep.video_url;
}

export function feedToSummary(
  item: FeedItem,
  moduleKey?: string,
  moduleType?: string,
): DramaSummary {
  return {
    id: item.key,
    title: item.title,
    cover: item.cover,
    description: item.desc ?? '',
    tags: [...(item.tag ?? []), ...(item.series_tag ?? [])],
    moduleKey,
    moduleType,
  };
}

export function detailToSummary(info: DetailInfo): DramaSummary {
  return {
    id: info.id,
    title: info.name,
    cover: info.cover,
    description: info.desc ?? '',
    tags: [...(info.tag ?? []), ...(info.series_tag ?? [])],
  };
}

export function toEpisodeSummary(ep: RawEpisode, index: number): EpisodeSummary {
  return {
    id: ep.id,
    number: index + 1,
    title: ep.name,
    cover: ep.cover,
    streamUrl: pickStreamUrl(ep),
    subtitles: (ep.subtitle_list ?? [])
      .filter((s) => !!s.subtitle)
      .map((s) => ({ language: s.language, displayName: s.display_name ?? s.language, url: s.subtitle })),
  };
}

export function buildDetail(info: DetailInfo): DramaDetail {
  return {
    ...detailToSummary(info),
    episodeCount: info.episode_list?.length ?? info.episode_count ?? 0,
    episodes: (info.episode_list ?? []).map((ep, i) => toEpisodeSummary(ep, i)),
  };
}

/** Simpan drama (dan optional episode) dari sumber eksternal. */
export async function upsertDramaFromDetail(
  info: DetailInfo,
  feedType: string,
  ttlSeconds: number,
  provider: string = 'freereels',
): Promise<void> {
  const slug = slugify(info.name);
  const cover = info.cover;
  const payload = {
    provider,
    title: info.name,
    slug,
    description: info.desc ?? '',
    posterUrl: cover,
    coverUrl: cover,
    category: feedType,
    type: feedType,
    totalEpisodes: info.episode_list?.length ?? info.episode_count ?? 0,
    viewCount: info.view_count ? BigInt(info.view_count) : null,
    followCount: info.follow_count ? BigInt(info.follow_count) : null,
    finishStatus: info.finish_status,
    externalData: info as unknown as object,
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    lastFetchedAt: new Date(),
    lastRefreshStatus: 'ok',
    refreshAttempt: 0,
  };
  await prisma.drama.upsert({
    where: { provider_externalId: { provider, externalId: info.id } },
    create: { externalId: info.id, ...payload },
    update: { ...payload },
  });
}

export async function upsertEpisodes(info: DetailInfo, provider: string = 'freereels'): Promise<void> {
  const drama = await prisma.drama.findUnique({
    where: { provider_externalId: { provider, externalId: info.id } },
  });
  if (!drama) return;
  const episodes = info.episode_list ?? [];
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    await prisma.episode.upsert({
      where: { dramaId_externalEpId: { dramaId: drama.id, externalEpId: ep.id } },
      create: {
        dramaId: drama.id,
        externalEpId: ep.id,
        episodeNumber: i + 1,
        title: ep.name,
        thumbnailUrl: ep.cover,
        videoUrl: pickStreamUrl(ep),
        h264M3u8Url: ep.external_audio_h264_m3u8 || null,
        h265M3u8Url: ep.external_audio_h265_m3u8 || null,
        subtitleList: asJson(ep.subtitle_list),
        externalData: asJson(ep),
      },
      update: {
        title: ep.name,
        thumbnailUrl: ep.cover,
        videoUrl: pickStreamUrl(ep),
        h264M3u8Url: ep.external_audio_h264_m3u8 || null,
        h265M3u8Url: ep.external_audio_h265_m3u8 || null,
        subtitleList: asJson(ep.subtitle_list),
        externalData: asJson(ep),
      },
    });
  }
}

export async function upsertDramasFromFeed(
  provider: string,
  items: FeedItem[],
  moduleType: string | undefined,
  moduleKey: string | undefined,
  feedType: string,
): Promise<number> {
  let count = 0;
  const CONCURRENCY = 6;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        if (!item?.key) return;
        const slug = slugify(item.title);
        const payload = {
          provider,
          title: item.title,
          slug,
          description: item.desc ?? '',
          posterUrl: item.cover,
          coverUrl: item.cover,
          category: feedType,
          type: moduleType || feedType,
          externalData: item as unknown as object,
        };
        await prisma.drama.upsert({
          where: { provider_externalId: { provider, externalId: item.key } },
          create: { externalId: item.key, cachedAt: new Date(), lastFetchedAt: new Date(), ...payload },
          update: { ...payload },
        });
        if (moduleKey) {
          // jejak feed asal untuk analisis; tanpa entitas terpisah.
          void moduleKey;
        }
        count++;
      }),
    );
  }
  return count;
}

export async function findDramaWithEpisodes(provider: string, externalId: string) {
  return prisma.drama.findUnique({
    where: { provider_externalId: { provider, externalId } },
    include: {
      episodes: { orderBy: { episodeNumber: 'asc' } },
    },
  });
}

export async function searchDramas(provider: string, query: string): Promise<DramaSummary[]> {
  const rows = await prisma.drama.findMany({
    where: {
      provider,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.externalId,
    title: r.title,
    cover: r.posterUrl ?? '',
    description: r.description ?? '',
    tags: [],
  }));
}