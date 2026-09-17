import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();
// Konvensi repo: nilai bisa ditaruh di backend/.env atau root ../.env (mis. EXTERNAL_API_BASE_URL).
try {
  dotenv.config({ path: path.resolve(process.cwd(), '../.env'), override: false });
} catch {
  // .env root tidak ada — lanjut dengan backend/.env saja.
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi'),
  EXTERNAL_API_BASE_URL: z.string().url().optional(),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(8),
  CACHE_DEFAULT_TTL: z.coerce.number().int().positive().default(1800),
  FORYOU_TTL: z.coerce.number().int().positive().default(1800),
  HOMEPAGE_TTL: z.coerce.number().int().positive().default(2700),
  ANIME_TTL: z.coerce.number().int().positive().default(2700),
  SEARCH_TTL: z.coerce.number().int().positive().default(1800),
  DETAIL_TTL: z.coerce.number().int().positive().default(3600),
  CONTOH_EXECUTE_DIR: z.string().default(''),
  // ScraperAPI (rotasi IP terkelola): dipakai request keluar saat mode live.
  // `https://api.scraperapi.com/?api_key=...&url=<target>` — tanpa key → jalur langsung.
  SCRAPERAPI_API_KEY: z.string().optional(),
  // paksa mode fixture (TANPA jaringan) meski EXTERNAL_API_BASE_URL terisi — dipakai smoke test.
  EXTERNAL_FIXTURE: z.string().optional(),
  // Base URL publik backend (dipakai rewire host stream proxy MovieBox).
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
});

function resolveContohDir(): string {
  const configured = process.env.CONTOH_EXECUTE_DIR;
  const candidates = [
    configured,
    path.resolve(process.cwd(), '../CONTOHEXECUTE'),
    path.resolve(process.cwd(), 'CONTOHEXECUTE'),
    path.resolve(process.cwd(), '../../CONTOHEXECUTE'),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // abaikan, coba kandidat berikutnya
    }
  }
  return candidates[0] ?? '../CONTOHEXECUTE';
}

const parsed = envSchema.parse(process.env);

export const config = {
  ...parsed,
  isProduction: parsed.NODE_ENV === 'production',
  kontohDir: resolveContohDir(),
  // fixture = mode demo aman (tanpa jaringan), kecuali user eksplisit memaksa live.
  useFixture: !parsed.EXTERNAL_API_BASE_URL || parsed.EXTERNAL_FIXTURE === '1',
};

export type Config = typeof config;