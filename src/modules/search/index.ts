import type { FastifyInstance } from 'fastify';
import { providerService, isProvider } from '../../services/providers.js';
import type { DramaProviderId } from '../../services/providers.js';
import { searchDramas } from '../../services/dramaService.js';
import type { ApiWrapper } from '../feed/index.js';

interface SearchData {
  page_info?: { next?: string; has_more?: boolean };
  items?: SearchItem[];
  [k: string]: unknown;
}

interface SearchItem {
  key?: string;
  title?: string;
  cover?: string;
  desc?: string;
}

export async function searchRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (req, reply) => {
    const { query, page = '' } = req.query as { query?: string; page?: string };
    const providerRaw = (req.query as Record<string, unknown>).provider;
    const provider: DramaProviderId = isProvider(providerRaw) ? providerRaw : 'freereels';
    const q = (query ?? '').trim();

    if (q === '') {
      return reply.code(400).send({
        code: 400,
        message: 'Parameter "query" wajib diisi',
        data: null,
      });
    }
    if (q.length < 3) {
      return reply.code(400).send({
        code: 400,
        message: 'Minimal 3 karakter untuk pencarian',
        data: null,
      });
    }

    // 1) Database first — hindari request eksternal bila ada hasil.
    const dbResults = await searchDramas(provider, q);
    if (dbResults.length > 0 && page === '') {
      return {
        code: 200,
        message: 'success',
        data: { source: 'database', items: dbResults, page_info: { next: '', has_more: false } },
      } satisfies ApiWrapper<unknown>;
    }

    // 2) Fallback eksternal (dengan cache per provider+query).
    const result = await providerService.search(provider, q, page);

    const items = result.items.map((it) => ({ key: it.id, title: it.title, cover: it.cover, desc: it.description }));

    return {
      code: 200,
      message: 'success',
      data: {
        source: items.length > 0 ? 'external' : 'empty',
        items,
        page_info: { next: result.next, has_more: result.hasMore },
      },
    } satisfies ApiWrapper<unknown>;
  });
}