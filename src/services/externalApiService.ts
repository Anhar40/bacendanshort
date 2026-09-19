/**
 * Jalur keluar SATU-SATUNYA menuju API eksternal (atau fixture CONTOHEXECUTE).
 *
 * - Semua request diantrekan (FIFO, satu per satu) — TANPA rate limiter per menit.
 *   Pengaman loop tetap ada: single-flight (request identik berbagi satu fetch),
 *   proxy terkelola ScraperAPI (bila key terisi), dan cooldown singkat saat 403/5xx.
 * - Single-flight: request identik yang datang bersamaan berbagi satu fetch.
 * - Provider-aware:
 *     * freereels → `{EXTERNAL_API_BASE_URL}/api/freereels/{endpoint}`
 *     * pinedrama → `{EXTERNAL_API_BASE_URL}/api/pinedrama/{endpoint}`
 *     * melolo → `{EXTERNAL_API_BASE_URL}/api/melolo/{endpoint}`
 *     * moviebox → `{EXTERNAL_API_BASE_URL}/api/moviebox/{endpoint}`
 *   Saat base URL provider tidak diisi (dev), service membaca hasil JSON mentah
 *   dari folder CONTOHEXECUTE — TANPA menyentuh jaringan sama sekali.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import type { DramaProviderId } from './providers.js';

export interface ExternalEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

const FREEREELS_FIXTURE: Record<string, (params: Record<string, string>) => string> = {
  foryou: () => 'httpsapi.sansekai.my.idapifreereelsforyou.json',
  homepage: () => 'httpsapi.sansekai.my.idapifreereelshomepage.json',
  animepage: () => 'httpsapi.sansekai.my.idapifreereelsanimepage.json',
  search: (p) => `httpsapi.sansekai.my.idapifreereelssearchquery=${p.query ?? ''}.json`,
  detailAndAllEpisode: (p) =>
    `httpsapi.sansekai.my.idapifreereelsdetailAndAllEpisodekey=${p.key ?? ''}.json`,
};

const PINEDRAMA_FIXTURE: Record<string, string> = {
  foryou: 'foryou.json',
  trending: 'trending.json',
  search: 'search.json',
  detail: 'detail.json',
  'get-episode': 'episode.json',
};

// Fixture Melolo dari CONTOHEXECUTE/melolo/ (catatan: file trending bernama "tranding.json").
const MELOLO_FIXTURE: Record<string, string> = {
  foryou: 'foryou.json',
  latest: 'latest.json',
  trending: 'tranding.json',
  anime: 'anime.json',
  search: 'search.json',
  detail: 'detail.json',
  'get-episode': 'getepisode.json',
};

// Fixture MovieBox dari CONTOHEXECUTE/moviebox/.
const MOVIEBOX_FIXTURE: Record<string, string> = {
  'k-drama': 'k-drama.json',
  'hollywood-movies': 'hollywood-movies.json',
  'indo-movies': 'indo-movies.json',
  homepage: 'homepage.json',
  search: 'search.json',
  detail: 'detail.json',
};

/** Status yang dianggap gangguan sementara → layak di-retry dengan backoff. */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/** Jeda (ms) sebelum percobaan ulang — total maks 3 percobaan per request. */
const RETRY_BACKOFF_MS = [500, 1500];

/** Lama "istirahat" satu (provider,endpoint) setelah upstream kena gangguan sementara. */
const UPSTREAM_COOLDOWN_MS = 60_000;

/**
 * Kumpulan User-Agent modern (2026). Dipilih acak per request agar tidak
 * terlihat sebagai bot tunggal oleh WAF upstream.
 */
const USER_AGENTS = [
  // Chrome Desktop — Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  // Chrome Desktop — macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  // Microsoft Edge (Chromium) — Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
  // Safari — macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  // Safari — iOS
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  // Chrome Mobile — Android
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  // Chrome Mobile — Android (Samsung)
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ContentUnavailableError extends Error {
  constructor(public readonly externalId: string) {
    super(`Konten "${externalId}" tidak tersedia`);
    this.name = 'ContentUnavailableError';
  }
}

class ExternalApiService {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private queueTail: Promise<void> = Promise.resolve();
  private readonly upstreamCooldownUntil = new Map<string, number>();

  private static cooldownKey(provider: DramaProviderId, endpoint: string): string {
    return `${provider}:${endpoint}`;
  }

  private markCooldown(provider: DramaProviderId, endpoint: string): void {
    this.upstreamCooldownUntil.set(
      ExternalApiService.cooldownKey(provider, endpoint),
      Date.now() + UPSTREAM_COOLDOWN_MS,
    );
  }

  /** Endpoint feed/daftar: 404 berulang dari upstream = API-nya sedang mati, bukan konten hilang. */
  private static readonly FEED_ENDPOINTS = new Set([
    'foryou',
    'homepage',
    'animepage',
    'trending',
    'search',
    'home',
    'latest',
    'anime',
  ]);
  private readonly notFoundStreak = new Map<string, number>();

  /** Single-flight: request serupa yang sedang berjalan berbagi satu fetch. */
  private singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Antrekan FIFO: tiap request menunggu request sebelumnya selesai. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(task);
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Ambil data mentah dari API eksternal provider (atau fixture).
   * `clientIp` opsional — untuk rate-limit/identitas per-user. Dimasukkan ke key
   * single-flight agar request antar-user dengan params serupa tidak berbagi
   * satu fetch (per-user dedup, bukan global).
   */
  request<T>(
    provider: DramaProviderId,
    endpoint: string,
    params: Record<string, string> = {},
    clientIp?: string,
  ): Promise<ExternalEnvelope<T>> {
    const key = `${provider}:${endpoint}${clientIp ? `:${clientIp}` : ''}?${new URLSearchParams(params).toString()}`;
    return this.singleFlight(key, () =>
      this.enqueue(() => this.doRequest<T>(provider, endpoint, params, clientIp)),
    );
  }

  private async doRequest<T>(
    provider: DramaProviderId,
    endpoint: string,
    params: Record<string, string>,
    clientIp?: string,
  ): Promise<ExternalEnvelope<T>> {
    if (config.useFixture) {
      return this.readFixture<T>(provider, endpoint, params);
    }
    const until = this.upstreamCooldownUntil.get(ExternalApiService.cooldownKey(provider, endpoint)) ?? 0;
    if (until > Date.now()) {
      // Upstream baru saja membalas gangguan sementara (403/timeout/5xx) — jangan serbu dulu.
      throw new Error(
        `Upstream ${provider}/${endpoint} sedang cooldown (${Math.ceil((until - Date.now()) / 1000)}s tersisa)`,
      );
    }
    return this.fetchLive<T>(provider, endpoint, params, clientIp);
  }

  /**
   * Fetch ke target URL. Bila `SCRAPERAPI_API_KEY` terisi → lewat ScraperAPI
   * (rotasi IP terkelola, IP lokal tidak lagi dipakai ke upstream). Tanpa key →
   * jalur langsung (IP lokal — rawan diblacklist upstream).
   *
   * Kadang ScraperAPI MENOLAK mengambil target ("Request failed... Protected
   * domains may require adding premium=true") — itu BUKAN status upstream,
   * melainkan penolakan proxy. Dalam kasus itu fallback sekali ke jalur langsung
   * agar layanan tetap jalan (risiko blacklist IP ditanggung).
   */
  private async fetchTarget(url: URL, headers: Record<string, string>): Promise<Response> {
    if (!config.SCRAPERAPI_API_KEY) return undiciFetch(url, { headers });
    const target = new URL('https://api.scraperapi.com/');
    target.searchParams.set('api_key', config.SCRAPERAPI_API_KEY);
    target.searchParams.set('url', url.toString());
    // Pertahankan header kustom (X-Forwarded-For, User-Agent, dst.) agar tidak
    // dibuang oleh proxy ScraperAPI.
    target.searchParams.set('keep_headers', 'true');
    const proxyRes = await undiciFetch(target, { headers });
    if (await this.isScraperRefusal(proxyRes)) {
      console.warn(`[external] ScraperAPI menolak ${url.host}${url.pathname} → fallback langsung`);
      return undiciFetch(url, { headers });
    }
    return proxyRes;
  }

  /** ScraperAPI menolak fetch (bukan status upstream): 500 + pesan khas proxy gagal. */
  private async isScraperRefusal(res: Response): Promise<boolean> {
    if (res.status !== 500) return false;
    const probe = res.clone();
    const text = await probe.text().catch(() => '');
    return /Request failed|You will not be charged|Protected domains|premium(?:=|\s)true/i.test(text);
  }

  private async fetchLive<T>(
    provider: DramaProviderId,
    endpoint: string,
    params: Record<string, string>,
    clientIp?: string,
  ): Promise<ExternalEnvelope<T>> {
    let url: URL;
    if (provider === 'pinedrama') {
      if (!config.EXTERNAL_API_BASE_URL) {
        throw new Error('PINEDRAMA_API_BASE_URL belum diset, pinedrama live tidak bisa dipakai');
      }
      url = new URL(`/api/pinedrama/${endpoint}`, config.EXTERNAL_API_BASE_URL);
    } else if (provider === 'melolo') {
      if (!config.EXTERNAL_API_BASE_URL) {
        throw new Error('EXTERNAL_API_BASE_URL belum diset, melolo live tidak bisa dipakai');
      }
      url = new URL(`/api/melolo/${endpoint}`, config.EXTERNAL_API_BASE_URL);
    } else if (provider === 'moviebox') {
      if (!config.EXTERNAL_API_BASE_URL) {
        throw new Error('EXTERNAL_API_BASE_URL belum diset, moviebox live tidak bisa dipakai');
      }
      url = new URL(`/api/moviebox/${endpoint}`, config.EXTERNAL_API_BASE_URL);
    } else {
      url = new URL(`/api/freereels/${endpoint}`, config.EXTERNAL_API_BASE_URL);
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastError: unknown = new Error(`External API gagal untuk ${provider}/${endpoint}`);
    // Header mirip browser: WAF upstream sering membalas 404/403 untuk UA bot (node).
    // UA diacak per request (rotasi User-Agent) untuk menghindari pola bot tunggal.
    const headers: Record<string, string> = {
      'User-Agent': getRandomUserAgent(),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      // Referer serendah-rendahnya: root host API sendiri (bukan situs lain),
      // membantu WAF kalau ia memvalidasi keberadaan referer per path.
      Referer: `${url.origin}/`,
    };
    // Info klien asli diteruskan sebagai header spoof web-server biasa; berguna
    // untuk per-user rate limit upstream dan melewati WAF yang mencurigai IP.
    if (clientIp) {
      headers['X-Forwarded-For'] = clientIp;
      headers['X-Real-IP'] = clientIp;
      headers['Client-IP'] = clientIp;
    }
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      let res: Response;
      try {
        res = await this.fetchTarget(url, headers);
      } catch (err) {
        // Gangguan jaringan (connect timeout, DNS, ScraperAPI mati) — retry dengan backoff.
        lastError = err;
        if (attempt < RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        this.markCooldown(provider, endpoint);
        break;
      }
      if (res.ok) {
        this.notFoundStreak.delete(ExternalApiService.cooldownKey(provider, endpoint));
        // freereels membungkus respons dengan envelope {code,message,data};
        // pinedrama mengembalikan objek polos → bungkus supaya downstream konsisten.
        const parsed = (await res.json()) as unknown;
        const isEnvelope =
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).code === 'number' &&
          typeof (parsed as Record<string, unknown>).message === 'string';
        if (isEnvelope) return parsed as ExternalEnvelope<T>;
        return { code: 200, message: 'success', data: parsed as T } as ExternalEnvelope<T>;
      }
      // 404 pada detail/episode = konten tidak tersedia di upstream (bukan gangguan sementara).
      if (res.status === 404 && (endpoint === 'detailAndAllEpisode' || endpoint === 'detail' || endpoint === 'get-episode' || endpoint === 'getepisode')) {
        throw new ContentUnavailableError(
          params.key ?? params.collection_id ?? params.book_id ?? params.videoId ?? params.video_id ?? 'Konten tidak dikenal',
        );
      }
      // 404 berulang pada endpoint feed = seluruh endpoint mati di upstream → istirahatkan dulu
      // supaya app & refresh job tidak terus menghujani API yang sedang 404.
      if (res.status === 404 && ExternalApiService.FEED_ENDPOINTS.has(endpoint)) {
        const cdKey = ExternalApiService.cooldownKey(provider, endpoint);
        const streak = (this.notFoundStreak.get(cdKey) ?? 0) + 1;
        if (streak >= 3) {
          this.notFoundStreak.delete(cdKey);
          this.markCooldown(provider, endpoint);
        } else {
          this.notFoundStreak.set(cdKey, streak);
        }
      }
      if (attempt < RETRY_BACKOFF_MS.length && RETRYABLE_STATUS.has(res.status)) {
        lastError = await this.externalError(provider, endpoint, res);
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        this.markCooldown(provider, endpoint);
      }
      throw await this.externalError(provider, endpoint, res);
    }
    throw lastError;
  }

  /** Bungkus status HTTP jadi pesan error, sertakan cuplikan body untuk diagnosa. */
  private async externalError(provider: DramaProviderId, endpoint: string, res: Response): Promise<Error> {
    let snippet = '';
    try {
      const text = (await res.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
      if (text) snippet = ` | body="${text}"`;
    } catch {
      // body sudah terpakai/tak terbaca — abaikan.
    }
    return new Error(`External API ${res.status} untuk ${provider}/${endpoint}${snippet}`);
  }

  private async readFixture<T>(
    provider: DramaProviderId,
    endpoint: string,
    params: Record<string, string>,
  ): Promise<ExternalEnvelope<T>> {
    let file: string;
    if (provider === 'pinedrama') {
      const name = PINEDRAMA_FIXTURE[endpoint];
      if (!name) throw new Error(`Tidak ada fixture pinedrama untuk endpoint "${endpoint}"`);
      file = path.join(config.kontohDir, 'pinedrama', name);
    } else if (provider === 'melolo') {
      const name = MELOLO_FIXTURE[endpoint];
      if (!name) throw new Error(`Tidak ada fixture melolo untuk endpoint "${endpoint}"`);
      file = path.join(config.kontohDir, 'melolo', name);
    } else if (provider === 'moviebox') {
      const name = MOVIEBOX_FIXTURE[endpoint];
      if (!name) throw new Error(`Tidak ada fixture moviebox untuk endpoint "${endpoint}"`);
      file = path.join(config.kontohDir, 'moviebox', name);
    } else {
      const buildName = FREEREELS_FIXTURE[endpoint];
      if (!buildName) throw new Error(`Tidak ada fixture freereels untuk endpoint "${endpoint}"`);
      file = path.join(config.kontohDir, 'freereels', buildName(params));
    }
    try {
      const rawContent = await fs.readFile(file, 'utf8');
      // fixture pinedrama & melolo punya baris pertama berupa URL rujukan / komentar → potong ke awal objek JSON.
      const jsonText =
        provider === 'pinedrama' || provider === 'melolo' ? rawContent.slice(rawContent.indexOf('{')) : rawContent;
      const parsed = JSON.parse(jsonText) as unknown;
      // pinedrama fixture polos → bungkus. melolo: sebagian sudah ber-Envelope, `getepisode.json` polos.
      if (provider === 'pinedrama') {
        return { code: 200, message: 'success', data: parsed } as ExternalEnvelope<T>;
      }
      if (provider === 'melolo') {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.code === 'number' && typeof rec.message === 'string') {
          return parsed as ExternalEnvelope<T>;
        }
        return { code: 200, message: 'success', data: parsed } as ExternalEnvelope<T>;
      }
      return parsed as ExternalEnvelope<T>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (endpoint === 'detailAndAllEpisode' || endpoint === 'detail' || endpoint === 'get-episode' || endpoint === 'getepisode') {
          throw new ContentUnavailableError(params.key ?? params.collection_id ?? params.book_id ?? params.videoId ?? params.subjectId ?? '');
        }
        // search dengan query yang tidak ada sample-nya → hasil kosong (sama seperti API asli)
        return { code: 200, message: 'success', data: {} as T };
      }
      throw err;
    }
  }
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

export const externalApiService = new ExternalApiService();
export type { ExternalApiService as ExternalApiServiceType };