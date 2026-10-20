import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { redis } from '../../config/redis';
import { CATEGORY_SYNONYMS, type CategoryInfo, catalogSnapshot } from './catalog';
import { AI_MODEL, type AiMode, FALLBACK_PARAMS, llm, logAiError } from './llm';

export const SORTS = ['ending', 'newest', 'price_asc', 'price_desc', 'popular'] as const;
/** Matches the condition values sellers use; "Used" matches every used grade. */
export const CONDITIONS = ['New', 'Refurbished', 'Used - excellent', 'Used - good', 'Used - fair', 'Used', 'For parts'] as const;
export type SortKey = (typeof SORTS)[number];

/** A free-text search turned into catalogue filters. */
export interface SearchIntent {
  q: string;
  categoryId?: string;
  categoryName?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  location?: string;
  condition?: string;
  status?: 'LIVE' | 'SOLD';
  sort?: SortKey;
  /** Short human summary of what was understood, e.g. "Vehicles · under $15,000 · Texas". */
  explanation: string;
  mode: AiMode;
}

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const STATE_CODES = new Set(Object.values(STATES));

const STOP_WORDS = new Set([
  'show', 'me', 'find', 'search', 'looking', 'look', 'for', 'a', 'an', 'the', 'with', 'and', 'any', 'some', 'i',
  'need', 'want', 'lots', 'lot', 'auction', 'auctions', 'please', 'in', 'near', 'around', 'of', 'that', 'are',
  'is', 'to', 'buy', 'get', 'listing', 'listings', 'items', 'item', 'equipment', 'on', 'at', 'from', 'all', 'my',
  'can', 'you', 'there', 'what', 'which', 'available', 'sale', 'deal', 'deals', 'cheap', 'good', 'or', 'either',
]);

const money = (dollars: number) => Math.round(dollars * 100);
const fmtUsd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/** "$15k", "15,000", "2.5m", "1200 dollars" → dollars. */
function parseAmount(raw: string, unit?: string): number {
  const n = Number(raw.replace(/,/g, ''));
  const u = unit?.toLowerCase();
  if (u === 'k' || u === 'thousand') return n * 1_000;
  if (u === 'm' || u === 'million') return n * 1_000_000;
  return n;
}

const AMOUNT = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|thousand|million)?\b`;

/** Rule-based reader. Fast and always available; the model refines it when configured. */
export function parseSearchHeuristic(input: string, categories: CategoryInfo[], knownLocations: string[] = []): SearchIntent {
  const original = input.trim().slice(0, 200);
  let text = ` ${original.toLowerCase()} `;
  const intent: SearchIntent = { q: '', explanation: '', mode: 'smart' };
  const consume = (re: RegExp) => {
    text = text.replace(re, ' ');
  };
  const drop = (matched: string) => {
    text = text.replace(matched, ' ');
  };

  // Price ranges first, then single-sided limits.
  const between = text.match(new RegExp(String.raw`(?:between|from)\s+${AMOUNT}\s+(?:and|to|-)\s+${AMOUNT}`));
  const dash = between ? null : text.match(new RegExp(String.raw`\$(\d[\d,.]*)\s?(k|m)?\s?(?:-|to)\s?\$?(\d[\d,.]*)\s?(k|m)?\b`));
  if (between?.[1] && between[3]) {
    intent.minPriceCents = money(parseAmount(between[1], between[2]));
    intent.maxPriceCents = money(parseAmount(between[3], between[4]));
    drop(between[0]);
  } else if (dash?.[1] && dash[3]) {
    intent.minPriceCents = money(parseAmount(dash[1], dash[2]));
    intent.maxPriceCents = money(parseAmount(dash[3], dash[4]));
    drop(dash[0]);
  }
  const max = text.match(new RegExp(String.raw`(?:under|below|less than|cheaper than|max(?:imum)?|up to|at most|<=?|budget(?: of)?)\s+${AMOUNT}`));
  if (max?.[1] && intent.maxPriceCents === undefined) {
    intent.maxPriceCents = money(parseAmount(max[1], max[2]));
    drop(max[0]);
  }
  const min = text.match(new RegExp(String.raw`(?:over|above|more than|min(?:imum)?|at least|starting at|>=?)\s+${AMOUNT}`));
  if (min?.[1] && intent.minPriceCents === undefined) {
    intent.minPriceCents = money(parseAmount(min[1], min[2]));
    drop(min[0]);
  }
  const around = text.match(new RegExp(String.raw`(?:around|about|approximately|roughly|~)\s+${AMOUNT}`));
  if (around?.[1] && intent.minPriceCents === undefined && intent.maxPriceCents === undefined) {
    const target = parseAmount(around[1], around[2]);
    intent.minPriceCents = money(target * 0.7);
    intent.maxPriceCents = money(target * 1.3);
    drop(around[0]);
  }
  if (
    intent.minPriceCents !== undefined &&
    intent.maxPriceCents !== undefined &&
    intent.minPriceCents > intent.maxPriceCents
  ) {
    [intent.minPriceCents, intent.maxPriceCents] = [intent.maxPriceCents, intent.minPriceCents];
  }

  // Sort and status hints.
  const sortHints: [RegExp, SortKey][] = [
    [/\b(cheapest|lowest price|lowest priced|low price|least expensive)\b/, 'price_asc'],
    [/\b(most expensive|highest price|highest priced|premium)\b/, 'price_desc'],
    [/\b(ending soon|closing soon|ends soon|ending today|closing today|last chance|about to end)\b/, 'ending'],
    [/\b(newest|just listed|new listings|latest|recently listed)\b/, 'newest'],
    [/\b(popular|hot|trending|most bids|most watched)\b/, 'popular'],
  ];
  for (const [re, sort] of sortHints) {
    if (re.test(text)) {
      intent.sort = sort;
      consume(new RegExp(re.source, 'g'));
      break;
    }
  }
  if (/\b(sold|past results|completed|closed auctions)\b/.test(text) && !/\bunsold\b/.test(text)) {
    intent.status = 'SOLD';
    consume(/\b(sold|past results|completed|closed auctions)\b/g);
  }

  // Condition.
  const conditions: [RegExp, string][] = [
    [/\b(like new|like-new|barely used|mint|excellent)\b/, 'Used - excellent'],
    [/\b(refurbished|refurb|reconditioned|rebuilt)\b/, 'Refurbished'],
    [/\b(for parts|parts only|not working|as-is|as is|salvage)\b/, 'For parts'],
    [/\b(brand new|new in box|unused|new)\b/, 'New'],
    [/\b(used|pre-owned|second hand|secondhand)\b/, 'Used'],
  ];
  for (const [re, condition] of conditions) {
    if (re.test(text)) {
      intent.condition = condition;
      consume(new RegExp(re.source, 'g'));
      break;
    }
  }

  // Location: a known pickup city, a US state name, or an upper-case state code.
  const lowerLocations = knownLocations.map((l) => ({ full: l, city: l.split(',')[0]!.trim().toLowerCase() }));
  const city = lowerLocations
    .filter((l) => l.city.length > 2 && new RegExp(String.raw`\b${l.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(text))
    .sort((a, b) => b.city.length - a.city.length)[0];
  if (city) {
    intent.location = city.full.split(',')[0]!.trim();
    consume(new RegExp(String.raw`\b(?:in|near|around)?\s*${city.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'g'));
  } else {
    const stateName = Object.keys(STATES)
      .sort((a, b) => b.length - a.length)
      .find((name) => new RegExp(String.raw`\b${name}\b`).test(text));
    const stateCode = stateName ? STATES[stateName] : undefined;
    if (stateName && stateCode) {
      intent.location = stateCode;
      consume(new RegExp(String.raw`\b(?:in|near|around)?\s*${stateName}\b`, 'g'));
    } else {
      const code = original.match(/\b([A-Z]{2})\b/g)?.find((c) => STATE_CODES.has(c));
      if (code) {
        intent.location = code;
        consume(new RegExp(String.raw`\b(?:in|near|around)?\s*${code.toLowerCase()}\b`, 'g'));
      }
    }
  }

  // Category: the longest synonym or category name found.
  let alternatives = false;
  let best: { category: CategoryInfo; phrase: string; generic: boolean } | null = null;
  for (const category of categories) {
    const phrases = [
      ...(CATEGORY_SYNONYMS[category.slug] ?? []).map((p) => ({ p, generic: false })),
      { p: category.name.toLowerCase(), generic: true },
      { p: category.slug.replace(/-/g, ' '), generic: true },
    ];
    for (const { p, generic } of phrases) {
      if (new RegExp(String.raw`\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(text)) {
        if (!best || p.length > best.phrase.length) best = { category, phrase: p, generic };
      }
    }
  }
  if (best) {
    intent.categoryId = best.category.id;
    intent.categoryName = best.category.name;
    // "forklifts or box trucks": several items of one category asked for as alternatives.
    // The category already says it; keeping both words would demand a lot that is both.
    const synonymHits = (CATEGORY_SYNONYMS[best.category.slug] ?? []).filter((p) =>
      new RegExp(String.raw`\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(text)
    );
    if (synonymHits.length >= 2 && /\b(or|and)\b|,|\//.test(text)) alternatives = true;
    // A category's own name says nothing beyond the filter; a specific word ("forklift") still narrows it.
    if (best.generic) consume(new RegExp(String.raw`\b${best.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'g'));
    // Filler that rides along with a category ("cnc machines", "office chairs") would only over-narrow.
    consume(/\b(machines?|equipment|office|units?|gear|supplies|products|stuff|things)\b/g);
  }

  intent.q = text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !/^\d+(k|m)?$/.test(w))
    .slice(0, 6)
    .join(' ');
  if (alternatives) intent.q = '';
  intent.explanation = explain(intent);
  return intent;
}

export function explain(intent: Omit<SearchIntent, 'explanation' | 'mode'>) {
  const parts: string[] = [];
  if (intent.q) parts.push(`“${intent.q}”`);
  if (intent.categoryName) parts.push(intent.categoryName);
  if (intent.minPriceCents !== undefined && intent.maxPriceCents !== undefined) {
    parts.push(`${fmtUsd(intent.minPriceCents)}–${fmtUsd(intent.maxPriceCents)}`);
  } else if (intent.maxPriceCents !== undefined) {
    parts.push(`under ${fmtUsd(intent.maxPriceCents)}`);
  } else if (intent.minPriceCents !== undefined) {
    parts.push(`over ${fmtUsd(intent.minPriceCents)}`);
  }
  if (intent.location) parts.push(`near ${intent.location}`);
  if (intent.condition) parts.push(intent.condition.toLowerCase());
  if (intent.status === 'SOLD') parts.push('sold lots');
  const sortLabel: Record<SortKey, string> = {
    ending: 'ending soonest',
    newest: 'newest first',
    price_asc: 'lowest price first',
    price_desc: 'highest price first',
    popular: 'most popular',
  };
  if (intent.sort) parts.push(sortLabel[intent.sort]);
  return parts.join(' · ');
}

/** True when a query reads like a sentence rather than a product name, so the model is worth asking. */
export function looksNatural(query: string) {
  const q = query.toLowerCase();
  return (
    q.split(/\s+/).length >= 3 &&
    /\b(under|below|over|above|between|near|in|cheap|cheapest|ending|closing|newest|less than|more than|around|for parts|like new|refurbished|used|sold)\b|\$|\d+k\b/.test(
      q
    )
  );
}

const ModelIntent = z.object({
  keywords: z.string().describe('Product words to match in titles, e.g. "forklift" or "dell poweredge". Empty if none.'),
  categorySlug: z.string().nullable().describe('One of the provided category slugs, or null.'),
  minPriceUsd: z.number().nullable(),
  maxPriceUsd: z.number().nullable(),
  location: z.string().nullable().describe('City name or two-letter US state code, or null.'),
  condition: z.enum(CONDITIONS).nullable(),
  sort: z.enum(SORTS).nullable(),
  status: z.enum(['LIVE', 'SOLD']).nullable(),
});

const CACHE_TTL_S = 60 * 60;

/**
 * Reads a natural-language search. Uses Claude (structured output) when a key
 * is configured and the query reads like a sentence; otherwise, or if the call
 * fails, the rule-based reader answers.
 */
export async function parseSearch(query: string): Promise<SearchIntent> {
  const { categories, locations } = await catalogSnapshot();
  const heuristic = parseSearchHeuristic(query, categories, locations);
  if (!llm || !looksNatural(query)) return heuristic;

  const cacheKey = `ai:intent:${query.trim().toLowerCase().slice(0, 200)}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as SearchIntent;

  try {
    const response = await llm.beta.messages.parse({
      model: AI_MODEL,
      max_tokens: 2048,
      ...FALLBACK_PARAMS,
      output_config: { effort: 'low', format: betaZodOutputFormat(ModelIntent) },
      system:
        'You turn a buyer\'s search on SurplusBid, a B2B auction marketplace for industrial surplus, into catalogue filters. ' +
        'Only use a categorySlug from the list. Prices are in US dollars. Leave a field null unless the query clearly asks for it. ' +
        `Categories: ${categories.map((c) => `${c.slug} (${c.name})`).join(', ')}.`,
      messages: [{ role: 'user', content: query.slice(0, 200) }],
    });
    const parsed = response.stop_reason === 'refusal' ? null : response.parsed_output;
    if (!parsed) return heuristic;

    const category = categories.find((c) => c.slug === parsed.categorySlug);
    const intent: SearchIntent = { q: parsed.keywords.trim().slice(0, 100), explanation: '', mode: 'ai' };
    if (category) {
      intent.categoryId = category.id;
      intent.categoryName = category.name;
    }
    if (parsed.minPriceUsd !== null && parsed.minPriceUsd >= 0) intent.minPriceCents = money(parsed.minPriceUsd);
    if (parsed.maxPriceUsd !== null && parsed.maxPriceUsd > 0) intent.maxPriceCents = money(parsed.maxPriceUsd);
    if (parsed.location) intent.location = parsed.location.slice(0, 80);
    if (parsed.condition) intent.condition = parsed.condition;
    if (parsed.sort) intent.sort = parsed.sort;
    if (parsed.status) intent.status = parsed.status;
    intent.explanation = explain(intent);
    await redis.set(cacheKey, JSON.stringify(intent), 'EX', CACHE_TTL_S).catch(() => undefined);
    return intent;
  } catch (err) {
    logAiError('search-intent', err);
    return heuristic;
  }
}
