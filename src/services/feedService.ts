/**
 * Normalisasi feed dari API eksternal menjadi bentuk flat yang dipakai mobile.
 *
 * - Homepage/anime: data.items[] = module feed, tiap module punya items[] bersarang.
 * - ForYou: data.items[] = item drama langsung.
 * Keduanya dinormalisasi ke DramaSummary[] (dedupe by id).
 */
import type { FeedItem } from './dramaService.js';
import { feedToSummary } from './dramaService.js';
import type { DramaSummary, FeedEnvelope } from './dramaService.js';

interface FeedModule {
  type?: string;
  module_type?: string;
  module_key?: string;
  show_title?: boolean;
  module_name?: string;
  items?: unknown[];
}

export interface RawFeedData {
  page_info?: { next?: string; has_more?: boolean; next_page?: string };
  total?: number;
  items?: Array<FeedModule | FeedItem>;
}

export function normalizeFeed(rawData: RawFeedData): { data: FeedEnvelope } {
  const pageInfo = rawData.page_info ?? {};
  const next = pageInfo.next_page || pageInfo.next || '';
  const items: DramaSummary[] = [];
  const seen = new Set<string>();

  for (const row of rawData.items ?? []) {
    const module = row as FeedModule;
    if (module && Array.isArray(module.items) && module.items.length > 0) {
      // module feed (homepage/anime)
      for (const inner of module.items) {
        const item = inner as FeedItem;
        if (!item?.key || seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(feedToSummary(item, module.module_key, module.module_type || module.type));
      }
    } else {
      // item flat (foryou)
      const item = row as FeedItem;
      if (!item?.key || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(feedToSummary(item, undefined, undefined));
    }
  }

  return {
    data: {
      page_info: { next, has_more: !!pageInfo.has_more || !!next },
      items,
    },
  };
}