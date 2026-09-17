import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { isProvider } from '../../services/providers.js';
import type { DramaProviderId } from '../../services/providers.js';

/** Guest mode MVP: identitas dari header X-User-Id, default "guest". */
export function getUserId(req: { headers: Record<string, unknown> }): string {
  const value = req.headers['x-user-id'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'guest';
}

function readProvider(query: unknown): DramaProviderId {
  const raw = (query as Record<string, unknown>).provider;
  return isProvider(raw) ? raw : 'freereels';
}

async function ensureUser(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, username: userId === 'guest' ? 'Guest' : userId },
    update: {},
  });
}

const watchProgressSchema = z.object({
  dramaId: z.string().min(1),
  episodeId: z.string().min(1),
  provider: z.enum(['freereels', 'pinedrama', 'melolo']).optional(),
  progressSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().positive().optional(),
  completed: z.boolean().optional(),
});

export async function usersRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/me/continue-watching', async (req) => {
    const userId = getUserId(req);
    const provider = readProvider(req.query);
    const rows = await prisma.watchHistory.findMany({
      where: { userId, provider, completed: false },
      orderBy: { lastWatchedAt: 'desc' },
      take: 20,
      include: {
        drama: true,
        episode: true,
      },
    });
    const items = rows.map((r) => ({
      drama: {
        id: r.drama.externalId,
        title: r.drama.title,
        cover: r.drama.posterUrl ?? '',
      },
      episode: {
        id: r.episode.externalEpId,
        number: r.episode.episodeNumber,
        title: r.episode.title ?? '',
      },
      provider: r.provider,
      progressSeconds: r.progressSeconds,
      durationSeconds: r.durationSeconds,
      completed: r.completed,
      lastWatchedAt: r.lastWatchedAt,
    }));
    return { code: 200, message: 'success', data: { items } };
  });

  app.post('/api/me/watch-progress', async (req, reply) => {
    const userId = getUserId(req);
    const parsed = watchProgressSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ code: 400, message: 'Payload tidak valid', data: parsed.error.flatten() });
    }
    const body = parsed.data;
    const provider = body.provider ?? 'freereels';

    const drama = await prisma.drama.findUnique({
      where: { provider_externalId: { provider, externalId: body.dramaId } },
    });
    if (!drama) {
      return reply.code(404).send({ code: 404, message: 'Drama tidak ditemukan', data: null });
    }
    const episode = await prisma.episode.findFirst({
      where: { dramaId: drama.id, externalEpId: body.episodeId },
    });
    if (!episode) {
      return reply.code(404).send({ code: 404, message: 'Episode tidak ditemukan', data: null });
    }

    await ensureUser(userId);
    await prisma.watchHistory.upsert({
      where: { userId_provider_episodeId: { userId, provider, episodeId: episode.id } },
      create: {
        userId,
        provider,
        dramaId: drama.id,
        episodeId: episode.id,
        progressSeconds: body.progressSeconds,
        durationSeconds: body.durationSeconds,
        completed: body.completed ?? false,
      },
      update: {
        progressSeconds: body.progressSeconds,
        durationSeconds: body.durationSeconds,
        completed: body.completed ?? false,
        lastWatchedAt: new Date(),
      },
    });

    return { code: 200, message: 'success', data: { saved: true } };
  });

  app.get('/api/me/favorites', async (req) => {
    const userId = getUserId(req);
    const provider = readProvider(req.query);
    const rows = await prisma.favorite.findMany({
      where: { userId, provider },
      orderBy: { createdAt: 'desc' },
      include: { drama: true },
    });
    const items = rows.map((f) => ({
      id: f.drama.externalId,
      provider: f.drama.provider,
      title: f.drama.title,
      cover: f.drama.posterUrl ?? '',
      favoritedAt: f.createdAt,
    }));
    return { code: 200, message: 'success', data: { items } };
  });

  app.post('/api/me/favorites', async (req, reply) => {
    const userId = getUserId(req);
    const parsed = z
      .object({ dramaId: z.string().min(1), provider: z.enum(['freereels', 'pinedrama', 'melolo']).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 400, message: 'Payload tidak valid', data: null });
    }
    const provider = parsed.data.provider ?? 'freereels';
    const drama = await prisma.drama.findUnique({
      where: { provider_externalId: { provider, externalId: parsed.data.dramaId } },
    });
    if (!drama) {
      return reply.code(404).send({ code: 404, message: 'Drama tidak ditemukan', data: null });
    }
    await ensureUser(userId);
    const existing = await prisma.favorite.findUnique({
      where: { userId_provider_dramaId: { userId, provider, dramaId: drama.id } },
    });
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return { code: 200, message: 'success', data: { favorited: false } };
    }
    await prisma.favorite.create({ data: { userId, provider, dramaId: drama.id } });
    return { code: 200, message: 'success', data: { favorited: true } };
  });

  app.delete('/api/me/favorites/:dramaId', async (req, reply) => {
    const userId = getUserId(req);
    const { dramaId } = req.params as { dramaId: string };
    const provider = readProvider(req.query);
    const drama = await prisma.drama.findUnique({
      where: { provider_externalId: { provider, externalId: dramaId } },
    });
    if (!drama) {
      return reply.code(404).send({ code: 404, message: 'Drama tidak ditemukan', data: null });
    }
    const existing = await prisma.favorite.findUnique({
      where: { userId_provider_dramaId: { userId, provider, dramaId: drama.id } },
    });
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
    }
    return reply.code(204).send();
  });
}