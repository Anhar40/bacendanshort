process.env.EXTERNAL_FIXTURE = '1';
import { buildApp } from './src/app.js';
const app = buildApp();
const r = await app.inject({ method: 'GET', url: '/api/dramas/ToWdWLePx4' });
const j = r.json();
const eps = j.data?.episodes ?? [];
console.log('code', j.code, 'episodes', eps.length);
eps.slice(0, 3).forEach((e: { number: number; id: string; streamUrl: string }) =>
  console.log(`  ep.number=${e.number} id=${e.id} stream=${e.streamUrl ? 'YES' : 'EMPTY'} h264=${e.streamUrl.slice(0, 60)}`),
);
await app.close();