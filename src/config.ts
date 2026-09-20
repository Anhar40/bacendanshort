import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();
try {
  dotenv.config({ path: path.resolve(process.cwd(), '../.env'), override: false });
} catch {
  // .env root tidak ada — lanjut dengan backend/.env saja.
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Dibuat opsional agar server TIDAK CRASH jika lupa diisi di dashboard hosting
  DATABASE_URL: z.string().optional(),
  EXTERNAL_API_BASE_URL: z.string().url().optional().or(z.literal('')),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(8),
  CACHE_DEFAULT_TTL: z.coerce.number().int().positive().default(1800),
  FORYOU_TTL: z.coerce.number().int().positive().default(1800),
  HOMEPAGE_TTL: z.coerce.number().int().positive().default(2700),
  ANIME_TTL: z.coerce.number().int().positive().default(2700),
  SEARCH_TTL: z.coerce.number().int().positive().default(1800),
  DETAIL_TTL: z.coerce.number().int().positive().default(3600),
  CONTOH_EXECUTE_DIR: z.string().default(''),
  SCRAPERAPI_API_KEY: z.string().optional(),
  EXTERNAL_FIXTURE: z.string().optional(),
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
      // abaikan
    }
  }
  return candidates[0] ?? '../CONTOHEXECUTE';
}

// GUNAKAN safeParse ALIH-ALIH parse
const parsedResult = envSchema.safeParse(process.env);

if (!parsedResult.success) {
  console.error('❌ FATAL: Validasi Environment Variables Gagal!');
  console.error(JSON.stringify(parsedResult.error.format(), null, 2));
  process.exit(1);
}

const parsed = parsedResult.data;

export const config = {
  ...parsed,
  isProduction: parsed.NODE_ENV === 'production',
  kontohDir: resolveContohDir(),
  useFixture: !parsed.EXTERNAL_API_BASE_URL || parsed.EXTERNAL_FIXTURE === '1',
};

export type Config = typeof config;
