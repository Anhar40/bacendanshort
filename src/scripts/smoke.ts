/**
 * Smoke test backend via Fastify inject (tanpa listen port).
 * Selalu berjalan dalam MODE FIXTURE (tanpa jaringan ke API eksternal),
 * apa pun isi EXTERNAL_API_BASE_URL di .env.
 */
process.env.EXTERNAL_FIXTURE = '1';

const [{ buildApp }, { prisma }] = await Promise.all([
  import('../app.js'),
  import('../db.js'),
]);

type SmokeMethod = 'GET' | 'POST';
type SmokePayload = object | string | undefined;

const app = buildApp();

async function hit(
  method: SmokeMethod,
  url: string,
  payload?: SmokePayload,
  headers?: Record<string, string>,
) {
  const res = await app.inject({ method, url, payload, headers });
  console.log(`\n${method} ${url} -> ${res.statusCode}`);
  const json = res.json();
  if (json && json.data !== null && json.data !== undefined) {
    const data = json.data as Record<string, unknown>;
    const keys = Object.keys(data);
    const sample =
      data.items && Array.isArray(data.items)
        ? `items=${(data.items as unknown[]).length} sample=${JSON.stringify((data.items as unknown[])[0] ?? {}).slice(0, 200)}`
        : data.episodes
          ? `episodes=${(data.episodes as unknown[]).length} first=${JSON.stringify((data.episodes as unknown[])[0]).slice(0, 160)}`
          : JSON.stringify(data).slice(0, 200);
    console.log(`  code=${json.code} keys=${keys.join(',')} ${sample}`);
  } else {
    console.log(`  ${JSON.stringify(json ?? res.body).slice(0, 300)}`);
  }
  return res;
}

async function main() {
  await hit('GET', '/api/health');

  // pastikan DB dalam keadaan bersih dari data test sebelumnya
  await prisma.watchHistory.deleteMany({ where: { userId: 'smoke-test-user' } });
  await prisma.favorite.deleteMany({ where: { userId: 'smoke-test-user' } });

  await hit('GET', '/api/foryou');
  await hit('GET', '/api/home');
  await hit('GET', '/api/anime');
  await hit('GET', '/api/providers');

  // provider ke-2 (Pine Drama) — fixture
  await hit('GET', '/api/foryou?provider=pinedrama');
  await hit('GET', '/api/trending?provider=pinedrama');
  await hit('GET', '/api/home?provider=pinedrama');
  await hit('GET', '/api/search?provider=pinedrama&query=ceo');
  await hit('GET', '/api/search?provider=pinedrama&query=zzz');
  await hit('GET', '/api/dramas/7679592907539731476?provider=pinedrama');
  await hit('GET', '/api/dramas/7679592907539731476/episodes?provider=pinedrama');
  await hit('GET', '/api/dramas/7679592907539731476/episodes/1?provider=pinedrama');
  // detail pinedrama kembali cepat saat cache DB fresh (skip tulis ulang)
  await hit('GET', '/api/dramas/7679592907539731476?provider=pinedrama');

  // provider ke-3 (Melolo) — fixture dari CONTOHEXECUTE/melolo/
  await hit('GET', '/api/foryou?provider=melolo');
  await hit('GET', '/api/foryou?provider=melolo&page=38');
  await hit('GET', '/api/trending?provider=melolo');
  await hit('GET', '/api/anime?provider=melolo');
  await hit('GET', '/api/home?provider=melolo');
  await hit('GET', '/api/search?provider=melolo&query=pewaris');
  await hit('GET', '/api/dramas/7583531888644459525?provider=melolo');
  await hit('GET', '/api/dramas/7583531888644459525/episodes?provider=melolo');
  await hit('GET', '/api/dramas/7583531888644459525/episodes/1?provider=melolo');

  await hit('GET', '/api/search?query=pe');
  await hit('GET', '/api/search?query=pewaris');

  await hit('GET', '/api/dramas/ToWdWLePx4');
  await hit('GET', '/api/dramas/ToWdWLePx4/episodes');

  const honey = { dramaId: 'ToWdWLePx4', episodeId: 'B610RWhGXq' };
  await hit('POST', '/api/me/watch-progress', { ...honey, progressSeconds: 260, durationSeconds: 600 }, { 'x-user-id': 'smoke-test-user' });
  await hit('GET', '/api/me/continue-watching', undefined, { 'x-user-id': 'smoke-test-user' });
  await hit('POST', '/api/me/favorites', { dramaId: 'ToWdWLePx4' }, { 'x-user-id': 'smoke-test-user' });
  await hit('GET', '/api/me/favorites', undefined, { 'x-user-id': 'smoke-test-user' });
  // watch progress & favorite terpisah per provider
  await hit('POST', '/api/me/watch-progress', { ...honey, provider: 'pinedrama', dramaId: '7679592907539731476', episodeId: '7679592907539731476:ep1', progressSeconds: 30, durationSeconds: 100 }, { 'x-user-id': 'smoke-test-user' });
  await hit('POST', '/api/me/favorites', { dramaId: '7679592907539731476', provider: 'pinedrama' }, { 'x-user-id': 'smoke-test-user' });
  await hit('GET', '/api/me/favorites?provider=pinedrama', undefined, { 'x-user-id': 'smoke-test-user' });

  // tes error handler: id tidak valid
  await hit('GET', '/api/dramas/' + encodeURIComponent('bad id;'));
  // drama yang tidak ada sample/fixture-nya → 404 "tidak tersedia di mode demo"
  await hit('GET', '/api/dramas/ZZZZZZZZZZ');
  // halaman tidak dikenal
  await hit('GET', '/api/tidak-ada');

  // beri kesempatan upsert background (fire-and-forget dari feed/detail) selesai
  // sebelum proses putus dari DB, agar tidak memicu "Response from the Engine was empty".
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await prisma.$disconnect();
  await app.close();
  console.log('\nSMOKE TEST SELESAI');
}

void main().catch(async (err) => {
  console.error('SMOKE TEST GAGAL:', err);
  await prisma.$disconnect();
  process.exit(1);
});