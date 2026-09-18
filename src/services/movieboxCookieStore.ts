/**
 * Penyimpanan sementara cookie CloudFront MovieBox per token pendek.
 *
 * Latar: URL `cdn-proxy` yang membawa cookie raw CloudFront (~600 char) dirender
 * sebagai query sangat panjang (>800 char). Pada stack lokal nyatanya request
 * sepanjang itu tidak andal (gagal `ERR_SSL_WRONG_VERSION_NUMBER` / curl exit 35)
 * meskipun ke origin yang sama. Karena cookie hanya dibutuhkan SEMUA request
 * dalam satu "sesi putar" dan hanya dipahami server kita, cookie disimpan di RAM
 * server dan URL yang dikirim ke mobile cukup membawa token acak pendek
 * (`&u=...`) — route `cdn-proxy` me-resolve token → cookie di setiap request
 * (manifest + setiap segmen m4s).
 *
 * CATATAN: in-memory per instance — cukup untuk MVP single-instance.
 */
import { randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const store = new Map<string, { cookie: string; expiresAt: number }>();

export function setSignCookieToken(cookie: string): string {
  if (store.size > MAX_ENTRIES) sweep();
  let token = randomToken();
  while (store.has(token)) token = randomToken();
  store.set(token, { cookie, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function getSignCookieByToken(token: string): string | undefined {
  const entry = store.get(token);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return undefined;
  }
  return entry.cookie;
}

function randomToken(): string {
  return randomBytes(8).toString('base64url');
}

/** Buang entri kedaluwarsa (dipanggil saat store mendekati kapasitas). */
function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}