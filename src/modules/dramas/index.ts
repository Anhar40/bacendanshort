import type { FastifyInstance } from 'fastify';
import { providerService, isProvider } from '../../services/providers.js';
import type { DramaProviderId } from '../../services/providers.js';
import { ContentUnavailableError } from '../../services/externalApiService.js';
import type { ApiWrapper } from '../feed/index.js';

function readProvider(query: unknown): DramaProviderId {
  const raw = (query as Record<string, unknown>).provider;
  return isProvider(raw) ? raw : 'freereels';
}

function isContentUnavailable(err: unknown): boolean {
  return err instanceof ContentUnavailableError ||
    (err instanceof Error && err.message.includes('tidak tersedia'));
}

export async function dramasRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/dramas/:externalId', async (req, reply) => {
    const { externalId } = req.params as { externalId: string };
    const provider = readProvider(req.query);
    if (!/^[A-Za-z0-9_:-]+$/.test(externalId)) {
      return reply.code(400).send({ code: 400, message: 'ID drama tidak valid', data: null });
    }

    try {
      const detail = await providerService.detail(provider, externalId);
      return { code: 200, message: 'success', data: detail } satisfies ApiWrapper<unknown>;
    } catch (err) {
      if (isContentUnavailable(err)) {
        return reply.code(404).send({ code: 404, message: 'Konten tidak tersedia', data: null });
      }
      app.log.error(err, 'Gagal mengambil detail drama');
      return reply.code(502).send({ code: 502, message: 'Tidak dapat memuat konten', data: null });
    }
  });

  app.get('/api/dramas/:externalId/episodes/:episodeNum', async (req, reply) => {
    const { externalId, episodeNum } = req.params as { externalId: string; episodeNum: string };
    const provider = readProvider(req.query);
    const num = Number(episodeNum);
    if (!Number.isInteger(num) || num < 1) {
      return reply.code(400).send({ code: 400, message: 'Nomor episode tidak valid', data: null });
    }
    try {
      const origin = `${req.protocol}://${req.headers.host}`;
      const episode = await providerService.episode(provider, externalId, num, origin);
      return { code: 200, message: 'success', data: { dramaId: externalId, provider, episode } } satisfies ApiWrapper<unknown>;
    } catch (err) {
      if (isContentUnavailable(err)) {
        return reply.code(404).send({ code: 404, message: 'Konten tidak tersedia', data: null });
      }
      app.log.error(err, 'Gagal mengambil episode');
      return reply.code(502).send({ code: 502, message: 'Tidak dapat memuat konten', data: null });
    }
  });

  app.get('/api/dramas/:externalId/episodes', async (req, reply) => {
    const { externalId } = req.params as { externalId: string };
    const provider = readProvider(req.query);
    try {
      const detail = await providerService.detail(provider, externalId);
      return {
        code: 200,
        message: 'success',
        data: { dramaId: externalId, provider, episodes: detail.episodes, episodeCount: detail.episodeCount },
      } satisfies ApiWrapper<unknown>;
    } catch (err) {
      if (isContentUnavailable(err)) {
        return reply.code(404).send({ code: 404, message: 'Konten tidak tersedia', data: null });
      }
      app.log.error(err, 'Gagal mengambil episode');
      return reply.code(502).send({ code: 502, message: 'Tidak dapat memuat konten', data: null });
    }
  });
}