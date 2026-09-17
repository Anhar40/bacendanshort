import { config } from './config.js';
import { prisma } from './db.js';
import { buildApp } from './app.js';
import { startRefreshJob } from './jobs/refreshCaches.js';

async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  startRefreshJob();

  // shutdown bersih
  const shutdown = async () => {
    await prisma.$disconnect();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();