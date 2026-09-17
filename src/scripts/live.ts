import { buildApp } from '../app.js';
import { prisma } from '../db.js';

const app = buildApp();
await app.listen({ port: 3210, host: '127.0.0.1' });
const r = await fetch('http://127.0.0.1:3210/api/foryou');
const j = (await r.json()) as { code: number; data: { items: unknown[] } };
console.log('LIVE_FORYOU_OK', r.status, j.code, j.data.items.length);
await app.close();
await prisma.$disconnect();