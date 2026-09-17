import { prisma } from './src/db.js';
(async () => {
  const rows = await prisma.apiCache.findMany({
    where: { provider: 'freereels', cacheKey: { startsWith: 'freereels:detailAndAllEpisode:' } },
    take: 3,
    orderBy: { updatedAt: 'desc' },
  });
  console.log('rows:', rows.length);
  for (const row of rows) {
    const rd = row.responseData as { info?: { id?: string; episode_list?: Array<{ index?: number; name?: string }> } };
    const info = rd?.info;
    const el = info?.episode_list;
    console.log('key:', row.cacheKey);
    if (el) {
      console.log('  stored episode_list length:', el.length);
      console.log('  first3 index:', el.slice(0, 3).map((e) => e.index ?? '?').join(','));
      console.log('  last3  index:', el.slice(-3).map((e) => e.index ?? '?').join(','));
    } else {
      console.log('  no episode_list. keys:', Object.keys(rd ?? {}).join(','));
    }
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});