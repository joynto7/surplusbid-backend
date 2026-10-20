import type { SortKey } from './searchIntent';

/** Friendly sort names (used by search parsing and the assistant) → browseLots sort fields. */
export const LOTS_SORT_MAP: Record<
  SortKey,
  { sortBy: 'endTime' | 'createdAt' | 'currentPriceCents' | 'popularity'; sortOrder: 'asc' | 'desc' }
> = {
  ending: { sortBy: 'endTime', sortOrder: 'asc' },
  newest: { sortBy: 'createdAt', sortOrder: 'desc' },
  price_asc: { sortBy: 'currentPriceCents', sortOrder: 'asc' },
  price_desc: { sortBy: 'currentPriceCents', sortOrder: 'desc' },
  popular: { sortBy: 'popularity', sortOrder: 'desc' },
};
