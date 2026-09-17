import type { FastifyInstance } from 'fastify';
import { providerService, PROVIDERS, isProvider } from '../../services/providers.js';
import type { DramaProviderId } from '../../services/providers.js';

export interface ApiWrapper<T> {
  code: number;
  message: string;
  data: T;
}

function readProvider(query: unknown): DramaProviderId {
  const raw = (query as Record<string, unknown>).provider;
  return isProvider(raw) ? raw : 'freereels';
}

export async function providersRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/providers', async () => ({
    code: 200,
    message: 'success',
    data: {
      items: Object.values(PROVIDERS),
    },
  } satisfies ApiWrapper<unknown>));
}

export async function foryouRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/foryou', async (req) => {
    const provider = readProvider(req.query);
    const { page = '' } = req.query as { page?: string };
    const data = await providerService.forYou(provider, page);
    return { code: 200, message: 'success', data } satisfies ApiWrapper<unknown>;
  });
}

export async function trendingRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/trending', async (req) => {
    const provider = readProvider(req.query);
    if (!PROVIDERS[provider].capabilities.trending) {
      return { code: 200, message: 'success', data: { page_info: { next: '', has_more: false }, items: [] } } satisfies ApiWrapper<unknown>;
    }
    const { page = '' } = req.query as { page?: string };
    const data = await providerService.trending(provider, page);
    return { code: 200, message: 'success', data } satisfies ApiWrapper<unknown>;
  });
}

export async function homepageRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/home', async (req) => {
    const provider = readProvider(req.query);
    const { page = '' } = req.query as { page?: string };
    const data = await providerService.home(provider, page);
    return { code: 200, message: 'success', data } satisfies ApiWrapper<unknown>;
  });
}

export async function animeRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/anime', async (req) => {
    const provider = readProvider(req.query);
    const data = await providerService.anime(provider);
    return { code: 200, message: 'success', data } satisfies ApiWrapper<unknown>;
  });
}