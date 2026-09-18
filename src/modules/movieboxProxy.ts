/**
 * Proksi konten MovieBox (streaming) — plugin Fastify.
 *
 * Alur resmi app moviebox: `get-download-url` → `proxy-video` → `cdn-proxy`.
 * Mobile HANYA boleh request ke backend kita, jadi route ini:
 *
 *   1. Menerima `?url=<CDN target>` + auth cookie: `&c=<signCookie>` (raw) atau
 *      `&u=<token pendek>` (token cookie yang disimpan server-side). Token
 *      membuat URL tetap pendek — cookie raw (~600 char) di URL panjang
 *      terbukti tidak andal di stack client.
 *   2. Fetch langsung ke CDN content (`*.hakunaymatata.com`) DENGAN cookie
 *      CloudFront (via header `Cookie`) server-side — mobile tidak pernah
 *      memegang cookie maupun menyentuh CDN/host API upstream.
 *   3. Manifest DASH (`*.mpd`) di-rewrite: referensi segmen relatif
 *      (`init-stream$RepresentationID$.m4s`, `chunk-stream$Number%05d$.m4s`)
 *      diubah jadi URL absolut ke route ini (domain kita); token templating
 *      (`$...$`) tetap literal agar player tetap bisa substitusi angka.
 *   4. Manifest HLS/teks (m3u8/srt/json) → host upstream di-rewrite ke domain kita.
 *   5. Segmen/biner (`*.m4s`, `*.mp4`, ...) di-stream apa adanya (passthrough
 *      byte) dengan dukungan `Range` (206 Partial Content) untuk player.
 *
 * CATATAN: route ini SENGAJA tidak lewat antrean externalApiService — selama
 * playback, segmen di-request frekuensi tinggi (puluhan-ribuan per menit);
 * memaksanya lewat queue ≤8 req/mnt membuat video tidak mungkin berputar.
 * Ini cermin infrastruktur CDN streaming upstream, bukan endpoint API JSON.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { getSignCookieByToken, setSignCookieToken } from '../services/movieboxCookieStore.js';

const CDN_HOST_SUFFIX = 'hakunaymatata.com';
const TEXTUAL_CT = /text\/|html|xml|json|mpegurl|subrip|utf-8/i;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export function movieboxProxyRoute(app: FastifyInstance): void {
  app.get('/api/moviebox/cdn-proxy', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const target = q.url ?? '';
    if (!target || !/^https?:\/\//.test(target)) {
      return reply.code(400).send({ code: 400, message: 'Parameter url wajib (http/https)', data: null });
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return reply.code(400).send({ code: 400, message: 'Parameter url tidak valid', data: null });
    }
    const hostname = parsed.hostname;
    if (!hostname.endsWith('.' + CDN_HOST_SUFFIX) && hostname !== CDN_HOST_SUFFIX) {
      return reply.code(400).send({ code: 400, message: 'Host target tidak diizinkan', data: null });
    }

    const cookie = q.c ?? undefined;
    // Token pendek (`&u=`) → cookie. Kalau request lama membawa cookie raw, kita
    // token-kan juga supaya URL segmen yang di-rewrite tetap pendek.
    const token = q.u ?? (cookie ? setSignCookieToken(cookie) : undefined);
    const resolvedCookie = token ? (getSignCookieByToken(token) ?? cookie) : cookie || undefined;
    const segAuth = token ? `&u=${encodeURIComponent(token)}` : '';
    const accept = req.headers.accept ?? '*/*';
    const range = req.headers.range;
    const contentType = q.t ?? undefined;
    const isManifestPath = /\.mpd(?:$|[?#])/.test(parsed.pathname);
    const isTextual = (contentType && TEXTUAL_CT.test(contentType)) || isManifestPath;
    const forceScraper = q.scrape === '1';

    const upRes = await fetchUpstream(target, accept, range, resolvedCookie, { binary: !isTextual, forceScraper });
    if (!upRes.ok) {
      const buf = Buffer.from(await upRes.arrayBuffer());
      copyHeaders(upRes, reply);
      return reply.code(upRes.status).send(buf);
    }

    const upContentType = upRes.headers.get('content-type') ?? '';
    copyHeaders(upRes, reply);

    if (isTextual) {
      const text = await upRes.text();
      if (text.length > MAX_MANIFEST_BYTES) {
        return reply.code(502).send({ code: 502, message: 'Manifest terlalu besar', data: null });
      }
      const selfOrigin = getSelfOrigin(req);
      const body = isManifestPath
        ? rewriteDashSegments(text, selfOrigin, parsed, segAuth)
        : rewriteHosts(text, hostname, selfOrigin);
      return reply.type(upContentType || 'application/xml').send(body);
    }

    // Segmen/biner: stream apa adanya (JANGAN buffer seluruh file — film bisa
    // ratusan MB) + ECHO status upstream. Request Range dari player HARUS
    // dibalas 206 + Content-Range; membalasnya sebagai 200 membuat ExoPlayer
    // gagal menghitung panjang media dan video tidak bisa diputar.
    if (upRes.body) {
      const stream = Readable.fromWeb(upRes.body as never);
      return reply.code(upRes.status).type(upContentType || 'application/octet-stream').send(stream);
    }
    const buf = Buffer.from(await upRes.arrayBuffer());
    return reply.code(upRes.status).type(upContentType || 'application/octet-stream').send(buf);
  });
}

const BLOCKED_STATUS = new Set([401, 403, 429, 444, 500, 502, 503, 504]);

/**
 * Fetch target CDN. Jalur utama: LANGSUNG ke CDN (cepat, streaming biner).
 * Bila IP datacenter diblokir (403/blocked status atau fetch gagal), otomatis
 * fallback lewat ScraperAPI (IP rotasi) agar konten tetap bisa diambil.
 * Bila `SCRAPERAPI_API_KEY` tidak diset, fallback dilewati.
 */
async function fetchUpstream(
  target: string,
  accept: string,
  range: string | undefined,
  cookie: string | undefined,
  opts: { binary: boolean; forceScraper?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = { accept };
  if (range) headers.range = range;
  if (cookie) headers.cookie = cookie;

  const direct = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      // undici global fetch (Node 18+) — backend tidak boleh memakai fetch ber-antrean.
      return await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  if (!opts.forceScraper && !config.SCRAPERAPI_API_KEY) return direct();

  let primary: Response | undefined;
  try {
    primary = await direct();
    if (!opts.forceScraper && primary.ok && !BLOCKED_STATUS.has(primary.status)) return primary;
  } catch {
    // direct gagal (DNS/timeout) → fallback scraper
  }

  if (!config.SCRAPERAPI_API_KEY) {
    if (primary) return primary;
    return new Response('CDN unreachable', { status: 502 });
  }

  const sp = new URL('https://api.scraperapi.com/');
  sp.searchParams.set('api_key', config.SCRAPERAPI_API_KEY);
  sp.searchParams.set('url', target);
  sp.searchParams.set('render', 'false');
  if (opts.binary) sp.searchParams.set('binary_target', 'true');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const viaScraper = await fetch(sp.toString(), { headers, redirect: 'follow', signal: ctrl.signal });
    if (!viaScraper.ok && primary) return primary;
    return viaScraper;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Host rewrite — berguna untuk m3u8 / srt / json, bukan DASH.
 * ═══════════════════════════════════════════════════════════════════════════════ */
function rewriteHosts(body: string, upstreamHost: string, selfOrigin: string): string {
  if (!upstreamHost) return body;
  const selfHost = new URL(selfOrigin).host;
  return upstreamHost === selfHost ? body : body.split(upstreamHost).join(selfHost);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * DASH segment rewrite — hanya atribut `initialization` & `media` yang
 * berisi path relativ ke base URL manifest (sesuai MPD spec).
 *
 * TIDAK menggunakan `encodeURIComponent` pada value karena:
 *   - value berisi token templating (`$RepresentationID$`, `$Number%05d$`)
 *     yang HARUS tetap literal agar ExoPlayer bisa substitusi sebelum HTTP
 *     request dilakukan.
 *   - filename DASH (`init-stream0.m4s`, `chunk-stream0-00001.m4s`)
 *     hanya berisi karakter yang aman di query string: alphanumeric,
 *     `.`, `-`, `_`, `$`, `%`.
 * ═══════════════════════════════════════════════════════════════════════════════ */
function rewriteDashSegments(body: string, selfOrigin: string, manifestUrl: URL, segAuth: string): string {
  const dir = `${manifestUrl.origin}${manifestUrl.pathname.slice(0, manifestUrl.pathname.lastIndexOf('/') + 1)}`;
  const dirEnc = encodeURIComponent(dir);
  const prefix = `${selfOrigin}/api/moviebox/cdn-proxy?url=${dirEnc}`;

  const replace = (_m: string, p1: string, value: string, p3: string) => {
    if (value.includes('://')) return `${p1}${value}${p3}`;
    return `${p1}${prefix}${value}${segAuth}${p3}`;
  };
  return body.replace(/((?:initialization|media|avcUrl|hevcUrl|url)=")([^"]+)(")/g, replace);
}

function getSelfOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host ?? new URL(config.PUBLIC_BASE_URL).host}`;
}

/** Forward header upstream yang relevan untuk konten streaming. */
function copyHeaders(upRes: Response, reply: FastifyReply): void {
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control']) {
    const value = upRes.headers.get(name);
    if (value) reply.header(name, value);
  }
}