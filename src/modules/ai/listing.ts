import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { catalogSnapshot } from './catalog';
import { AI_MODEL, type AiMode, FALLBACK_PARAMS, llm, logAiError } from './llm';
import { parseSearchHeuristic } from './searchIntent';
import { tokenize } from './text';

export const listingAssistSchema = z.object({
  title: z.string().trim().min(3).max(120),
  categoryId: z.string().uuid().optional(),
  condition: z.string().trim().max(40).optional(),
  quantity: z.number().int().positive().max(1_000_000).optional(),
  location: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1500).optional(),
});
export type ListingAssistInput = z.infer<typeof listingAssistSchema>;

const niceRound = (dollars: number) => {
  const step = dollars < 100 ? 5 : dollars < 1_000 ? 25 : dollars < 10_000 ? 100 : dollars < 100_000 ? 500 : 1_000;
  return Math.max(step, Math.round(dollars / step) * step);
};
const niceIncrement = (startingDollars: number) =>
  startingDollars < 500 ? 10 : startingDollars < 2_000 ? 25 : startingDollars < 10_000 ? 100 : startingDollars < 50_000 ? 250 : startingDollars < 200_000 ? 500 : 1_000;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/**
 * Price guidance from comparable sales: lots that sold in the same category
 * with titles sharing words with this one (falling back to the whole category,
 * then to live lots). Starting price ~60% and reserve ~85% of the comparable
 * median, increment scaled to the price.
 */
export async function priceFromComparables(title: string, categoryId?: string) {
  const words = new Set(tokenize(title));
  const pick = async (status: 'SOLD' | 'LIVE') => {
    const rows = await prisma.lot.findMany({
      where: { status, deletedAt: null, ...(categoryId ? { categoryId } : {}) },
      select: { id: true, title: true, currentPriceCents: true },
      orderBy: { endTime: 'desc' },
      take: 200,
    });
    const scored = rows
      .map((r) => {
        const t = new Set(tokenize(r.title));
        const shared = [...t].filter((w) => words.has(w)).length;
        return { ...r, similarity: shared / Math.max(1, new Set([...t, ...words]).size) };
      })
      .sort((a, b) => b.similarity - a.similarity);
    const close = scored.filter((s) => s.similarity > 0).slice(0, 8);
    return close.length >= 3 || !categoryId ? close : scored.slice(0, 12);
  };

  let comps = await pick('SOLD');
  let basisKind = 'sold';
  if (comps.length < 2) {
    comps = await pick('LIVE');
    basisKind = 'live';
  }
  if (!comps.length) return null;

  const mid = median(comps.map((c) => c.currentPriceCents)) / 100;
  const starting = niceRound(mid * 0.6);
  const category = categoryId ? await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true } }) : null;
  return {
    suggestedStartingPriceCents: starting * 100,
    suggestedReservePriceCents: Math.max(starting, niceRound(mid * 0.85)) * 100,
    suggestedIncrementCents: niceIncrement(starting) * 100,
    medianCents: Math.round(mid * 100),
    comparableCount: comps.length,
    basis: `Based on ${comps.length} ${basisKind === 'sold' ? 'similar lots sold' : 'live lots'}${category ? ` in ${category.name}` : ''} (median $${Math.round(mid).toLocaleString('en-US')}).`,
    comparables: comps.slice(0, 3).map((c) => ({ id: c.id, title: c.title, priceCents: c.currentPriceCents })),
  };
}

const CATEGORY_GUIDANCE: Record<string, string> = {
  machinery:
    'Inspection is welcome by appointment before the close. The buyer is responsible for rigging, loading and removal; forklift assistance at the dock can be arranged with the seller.',
  electronics:
    'Units are offered as listed. Data-bearing drives are removed or wiped unless the listing says otherwise, and power-on testing can be arranged by appointment.',
  vehicles:
    'Title and maintenance records go to the winning buyer. The vehicle can be inspected and started on site by appointment before the close.',
  furniture:
    'Items are sold together as one lot. The buyer handles disassembly and removal; loading dock access is available during business hours.',
  'raw-materials':
    'Material is stored indoors and sold by the lot as counted. The buyer arranges freight, and loading assistance is provided on site.',
  'medical-lab':
    'Equipment was decommissioned and cleaned by the facility. The buyer is responsible for any recalibration, recertification or regulatory checks before use.',
  'restaurant-equipment':
    'Equipment was in service until recently and has been cleaned. Gas or hard-wired units must be disconnected by a licensed technician arranged by the buyer.',
  'warehouse-logistics':
    'Components are offered as one lot. The buyer arranges dismantling and removal within the pickup window; pallet-jack access is available.',
};
const DEFAULT_GUIDANCE = 'Inspection is welcome by appointment. The buyer arranges pickup or freight after payment.';

/** Facts sellers usually write inline ("4,200 hours", "5,000 lb", "LPG") that buyers compare across lots. */
const INLINE_FACTS: { label: string; pattern: RegExp; format: (m: RegExpMatchArray) => string }[] = [
  { label: 'Hours', pattern: /\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:hours|hrs)\b/i, format: (m) => m[1]! },
  { label: 'Capacity', pattern: /\b(\d{1,3}(?:,\d{3})+|\d+)\s*(lbs?|kg)\b/i, format: (m) => `${m[1]} ${m[2]!.toLowerCase().replace('lbs', 'lb')}` },
  { label: 'Fuel / power', pattern: /\b(LPG|propane|diesel|gasoline|electric|natural gas)\b/i, format: (m) => (m[1]!.length <= 3 ? m[1]!.toUpperCase() : m[1]!.toLowerCase()) },
  { label: 'Voltage', pattern: /\b(\d{2,3})\s?V\b/, format: (m) => `${m[1]} V` },
  { label: 'Year', pattern: /\b(?:model year|year|built(?: in)?)\s*:?\s*((?:19|20)\d{2})\b/i, format: (m) => m[1]! },
];

/** "Brand: Haas" style lines become specifications, plus inline facts found in the title and notes. */
function specsFromNotes(notes?: string, title = '') {
  const explicit = (notes ?? '')
    .split(/\n|;/)
    .map((line) => line.match(/^\s*[-•*]?\s*([A-Za-z][\w /&()-]{1,38}):\s*(.{1,120})$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ label: m[1]!.trim(), value: m[2]!.trim() }));
  const known = new Set(explicit.map((s) => s.label.toLowerCase()));
  const text = `${title}\n${notes ?? ''}`;
  const inferred = INLINE_FACTS.flatMap(({ label, pattern, format }) => {
    const m = text.match(pattern);
    return m && !known.has(label.toLowerCase()) ? [{ label, value: format(m) }] : [];
  });
  return { explicit, all: [...explicit, ...inferred].slice(0, 10) };
}

/** "Used - good" → "good used condition", "New" → "new condition". */
function conditionPhrase(condition: string) {
  const c = condition.trim().toLowerCase();
  const used = c.match(/^used\s*[-–—]\s*(.+)$/);
  if (used) return `${used[1]} used condition`;
  if (c === 'for parts') return 'for-parts condition';
  return `${c} condition`;
}

function templateDraft(input: ListingAssistInput, categorySlug?: string) {
  const { explicit, all: specs } = specsFromNotes(input.notes, input.title);
  const freeNotes = (input.notes ?? '')
    .split('\n')
    .filter((line) => !/^\s*[-•*]?\s*[A-Za-z][\w /&()-]{1,38}:\s*.+$/.test(line))
    .join(' ')
    .trim();
  const qty = input.quantity && input.quantity > 1 ? `${input.quantity.toLocaleString('en-US')} units` : 'a single unit';
  const parts = [
    `${input.title}, offered as ${qty}${input.condition ? ` in ${conditionPhrase(input.condition)}` : ''}${input.location ? ` with pickup in ${input.location}` : ''}.`,
    freeNotes ? `${freeNotes.replace(/\s+/g, ' ').replace(/([^.!?])$/, '$1.')}` : '',
    // Inline facts are already in the free notes; only the "Label: value" lines need a sentence.
    explicit.length ? `Key details: ${explicit.map((s) => `${s.label.toLowerCase()} ${s.value}`).join(', ')}.` : '',
    CATEGORY_GUIDANCE[categorySlug ?? ''] ?? DEFAULT_GUIDANCE,
    'Every bidder places a refundable deposit hold before bidding, and late bids extend the clock by two minutes, so the close is fair to everyone.',
  ].filter(Boolean);
  const highlights = [
    input.condition ? `Condition: ${input.condition}` : null,
    input.quantity ? `Quantity: ${input.quantity.toLocaleString('en-US')}` : null,
    input.location ? `Pickup in ${input.location}` : null,
    'Inspection by appointment',
  ].filter((h): h is string => !!h);
  return { suggestedTitle: input.title, description: parts.join('\n\n'), highlights, specs };
}

const ListingDraft = z.object({
  suggestedTitle: z.string().describe('A clear, specific auction title under 90 characters'),
  description: z.string().describe('120 to 220 words in 2 or 3 plain-text paragraphs, no markdown'),
  highlights: z.array(z.string()).describe('3 to 5 short selling points'),
  specs: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe('Specifications stated in the title or notes only; empty if none'),
});

/**
 * Drafts a listing for a seller: Claude writes the copy when configured
 * (from the seller's facts only), otherwise a structured template does.
 * Price guidance always comes from real comparable sales.
 */
export async function listingAssist(input: ListingAssistInput) {
  // No category picked yet? Read it from the title ("CNC milling machine" → Machinery).
  const categoryId = input.categoryId ?? parseSearchHeuristic(input.title, (await catalogSnapshot()).categories).categoryId;
  const category = categoryId
    ? await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true, slug: true } })
    : null;
  const pricing = await priceFromComparables(input.title, categoryId);
  const template = templateDraft(input, category?.slug);

  if (llm) {
    try {
      const facts = [
        `Title: ${input.title}`,
        category ? `Category: ${category.name}` : null,
        input.condition ? `Condition: ${input.condition}` : null,
        input.quantity ? `Quantity: ${input.quantity}` : null,
        input.location ? `Pickup location: ${input.location}` : null,
        input.notes ? `Seller notes:\n${input.notes}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      const response = await llm.beta.messages.parse({
        model: AI_MODEL,
        max_tokens: 4096,
        ...FALLBACK_PARAMS,
        output_config: { effort: 'low', format: betaZodOutputFormat(ListingDraft) },
        system:
          'You write auction listings for SurplusBid, a B2B marketplace for industrial surplus. Write factual, professional copy that helps buyers bid with confidence. ' +
          'Use only the facts the seller gives. Never invent model years, hours, serial numbers, capacities, brands or test results. ' +
          'Where a buyer would want a fact that is missing, invite inspection rather than guessing. ' +
          `End with practical pickup or removal guidance: ${CATEGORY_GUIDANCE[category?.slug ?? ''] ?? DEFAULT_GUIDANCE}`,
        messages: [{ role: 'user', content: facts }],
      });
      const draft = response.stop_reason === 'refusal' ? null : response.parsed_output;
      if (draft?.description.trim()) {
        return {
          suggestedTitle: draft.suggestedTitle.trim().slice(0, 120) || input.title,
          description: draft.description.trim(),
          highlights: draft.highlights.map((h) => h.trim()).filter(Boolean).slice(0, 5),
          specs: draft.specs.filter((s) => s.label.trim() && s.value.trim()).slice(0, 10),
          pricing,
          mode: 'ai' as AiMode,
        };
      }
    } catch (err) {
      logAiError('listing-assist', err);
    }
  }
  return { ...template, pricing, mode: 'smart' as AiMode };
}
