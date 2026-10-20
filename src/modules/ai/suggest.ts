import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { stem } from '../lots/lots.service';
import { CATEGORY_SYNONYMS, catalogSnapshot } from './catalog';
import { trendingLots } from './recommend';
import { parseSearchHeuristic } from './searchIntent';
import { editDistance, tokenize } from './text';

const SUGGEST_SELECT = {
  id: true, title: true, images: true, status: true, currentPriceCents: true, endTime: true,
  category: { select: { name: true } },
} satisfies Prisma.LotSelect;

let vocabCache: { at: number; words: Map<string, number> } | null = null;

/** Word → frequency across lot titles, category names and synonyms (refreshed every 5 minutes). */
async function vocabulary() {
  if (vocabCache && Date.now() - vocabCache.at < 5 * 60 * 1000) return vocabCache.words;
  const rows = await prisma.lot.findMany({
    where: { deletedAt: null, status: { in: ['LIVE', 'SOLD'] } },
    select: { title: true },
    take: 2000,
  });
  const words = new Map<string, number>();
  const add = (w: string, n = 1) => words.set(w, (words.get(w) ?? 0) + n);
  for (const r of rows) for (const w of tokenize(r.title)) add(w);
  const { categories } = await catalogSnapshot();
  for (const c of categories) for (const w of tokenize(c.name)) add(w, 3);
  for (const list of Object.values(CATEGORY_SYNONYMS)) for (const phrase of list) for (const w of tokenize(phrase)) add(w, 2);
  vocabCache = { at: Date.now(), words };
  return words;
}

/** Closest known word within a small edit distance ("forklfit" → "forklift"). */
function correct(token: string, words: Map<string, number>) {
  if (token.length < 4 || words.has(token)) return token;
  const maxDistance = token.length >= 8 ? 2 : 1;
  let best: { word: string; distance: number; freq: number } | null = null;
  for (const [word, freq] of words) {
    if (Math.abs(word.length - token.length) > maxDistance) continue;
    const distance = editDistance(token, word, maxDistance);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance || (distance === best.distance && freq > best.freq)) {
      best = { word, distance, freq };
    }
  }
  return best?.word ?? token;
}

function lotsMatching(terms: string[]) {
  return prisma.lot.findMany({
    where: {
      deletedAt: null,
      status: { in: ['LIVE', 'SOLD'] },
      AND: terms.map(stem).map((t) => ({
        OR: [
          { title: { contains: t, mode: 'insensitive' as const } },
          { category: { name: { contains: t, mode: 'insensitive' as const } } },
        ],
      })),
    },
    select: SUGGEST_SELECT,
    // LIVE sorts before SOLD in the enum, so live lots come first.
    orderBy: [{ status: 'asc' }, { endTime: 'asc' }],
    take: 5,
  });
}

/**
 * As-you-type suggestions: matching lots (typo-tolerant), matching
 * categories, query completions, and a preview of how a natural-language
 * query will be read ("forklift under 15k in texas" → filters).
 */
export async function suggest(rawQuery: string) {
  const query = rawQuery.trim().slice(0, 100);
  const { categories, locations } = await catalogSnapshot();

  if (!query) {
    const [trending, counts] = await Promise.all([
      trendingLots(4),
      prisma.lot.groupBy({ by: ['categoryId'], where: { status: 'LIVE', deletedAt: null }, _count: { _all: true } }),
    ]);
    const liveByCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    return {
      query,
      correctedQuery: null,
      interpretation: null,
      lots: trending.map((l) => ({
        id: l.id, title: l.title, images: l.images, status: l.status, currentPriceCents: l.currentPriceCents,
        endTime: l.endTime, category: l.category, reason: l.reason,
      })),
      categories: categories
        .map((c) => ({ ...c, liveLotCount: liveByCategory.get(c.id) ?? 0 }))
        .sort((a, b) => b.liveLotCount - a.liveLotCount)
        .slice(0, 5),
      searches: ['forklift under $20,000', 'servers ending soon', 'cnc machines in texas', 'office furniture like new'],
    };
  }

  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 5);

  const intent = parseSearchHeuristic(query, categories, locations);
  const hasFilters =
    intent.categoryId !== undefined ||
    intent.minPriceCents !== undefined ||
    intent.maxPriceCents !== undefined ||
    intent.location !== undefined ||
    intent.condition !== undefined ||
    intent.sort !== undefined ||
    intent.status !== undefined;

  // When the query carries filters, match lots on the leftover keywords only.
  const lotTerms = hasFilters ? intent.q.split(/\s+/).filter(Boolean) : terms;
  let lots = lotTerms.length ? await lotsMatching(lotTerms) : [];
  let correctedQuery: string | null = null;
  if (!lots.length && lotTerms.length) {
    const words = await vocabulary();
    const fixed = lotTerms.map((t) => correct(t, words));
    if (fixed.join(' ') !== lotTerms.join(' ')) {
      lots = await lotsMatching(fixed);
      if (lots.length) correctedQuery = hasFilters ? query.replace(lotTerms.join(' '), fixed.join(' ')) : fixed.join(' ');
    }
  }

  const lower = query.toLowerCase();
  const matchedCategories = categories
    .filter((c) => {
      const synonyms = CATEGORY_SYNONYMS[c.slug] ?? [];
      return (
        c.name.toLowerCase().includes(lower) ||
        lower.includes(c.name.toLowerCase()) ||
        synonyms.some((s) => s.startsWith(lower) || lower.split(/\s+/).includes(s))
      );
    })
    .slice(0, 3);

  // Completions: titles that continue what was typed.
  const completions = [
    ...new Set(
      lots
        .map((l) => l.title)
        .filter((t) => t.toLowerCase().includes(lower) && t.toLowerCase() !== lower)
        .map((t) => t.split(/\s[–—-]\s|,/)[0]!.trim())
    ),
  ].slice(0, 3);

  return {
    query,
    correctedQuery,
    interpretation: hasFilters ? intent : null,
    lots,
    categories: matchedCategories,
    searches: completions,
  };
}
