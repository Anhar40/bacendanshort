import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { foryouRoute, homepageRoute, animeRoute, trendingRoute, providersRoute } from './modules/feed/index.js';
import { searchRoute } from './modules/search/index.js';
import { dramasRoute } from './modules/dramas/index.js';
import { usersRoute } from './modules/users/index.js';
import { movieboxProxyRoute } from './modules/movieboxProxy.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: config.isProduction
      ? true
      : {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', singleLine: true },
          },
        },
    // Di belakang TLS-terminating proxy (Abasthan/Cloudflare), `req.protocol` harus
    // menghormati `X-Forwarded-Proto` agar URL streaming yang kita bangun pakai
    // https (bukan http) — tanpa ini player Android menolak URL cleartext.
    trustProxy: true,
  });

  void app.register(cors, { origin: true });
  void app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/api/health', async () => ({
    code: 200,
    message: 'success',
    data: { status: 'ok', time: new Date().toISOString() },
  }));

  void app.register(providersRoute);
  void app.register(homepageRoute);
  void app.register(foryouRoute);
  void app.register(animeRoute);
  void app.register(trendingRoute);
  void app.register(searchRoute);
  void app.register(dramasRoute);
  void app.register(usersRoute);
  void app.register(movieboxProxyRoute);

  app.setErrorHandler((err, req, reply) => {
    if (err && typeof err === 'object' && 'statusCode' in err) {
      const statusCode = err.statusCode as number;
      if (statusCode === 429) {
        return reply.code(429).send({ code: 429, message: 'Terlalu banyak permintaan', data: null });
      }
    }
    req.log.error(err);
    return reply.code(500).send({ code: 500, message: 'Tidak dapat memuat konten', data: null });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: 404, message: 'Endpoint tidak ditemukan', data: null }),
  );

  return app;
}