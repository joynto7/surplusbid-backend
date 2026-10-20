import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { browseLots, getLotDetail, type PublicLot } from '../lots/lots.service';
import { publicStats } from '../stats/stats.routes';
import { catalogSnapshot } from './catalog';
import { KNOWLEDGE, knowledgeAsPrompt, matchKnowledge } from './knowledge';
import { AI_MODEL, type AiMode, FALLBACK_PARAMS, llm, logAiError } from './llm';
import { CONDITIONS, parseSearchHeuristic, SORTS } from './searchIntent';
import { LOTS_SORT_MAP } from './sorts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantLot {
  id: string;
  title: string;
  image: string | null;
  currentPriceCents: number;
  status: string;
  endTime: Date;
  location: string;
  category: string;
}

export interface AssistantReply {
  reply: string;
  lots: AssistantLot[];
  suggestions: string[];
  mode: AiMode;
}

const closeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function toCard(lot: PublicLot): AssistantLot {
  return {
    id: lot.id,
    title: lot.title,
    image: lot.images[0] ?? null,
    currentPriceCents: lot.currentPriceCents,
    status: lot.status,
    endTime: lot.endTime,
    location: lot.location,
    category: lot.category.name,
  };
}

function suggestionsFor(lotId?: string) {
  return lotId
    ? ["What's the minimum bid on this lot?", 'How does the deposit hold work?', 'Show me similar lots']
    : ['Find forklifts under $25,000', 'How do deposit holds work?', 'What happens after I win?', 'How do I sell surplus equipment?'];
}

const SYSTEM_PROMPT = `You are the SurplusBid Assistant, the help desk of SurplusBid: a B2B marketplace where verified businesses buy and sell industrial surplus (machinery, IT equipment, vehicles, furniture, raw materials, lab and restaurant equipment) in timed auctions.

How to help:
- Answer questions about how SurplusBid works from the policies below. If a policy doesn't cover something, say so and point to /contact.
- When someone asks about items, availability, prices or categories, call search_lots or get_lot_details. Never invent lots, prices or dates. Every lot you mention must come from a tool result.
- Link each lot you mention as a markdown link: [Lot title](/lots/<id>). Use other site paths from the policies, such as /faq.
- Keep replies short: two to five sentences, or a short bulleted list of lots. Amounts are in US dollars.
- You can't place bids, see account details or change anything. For those, send people to their dashboard.
- Don't give legal, tax or investment advice. Stay on topic. Politely decline unrelated requests.

Policies:
${knowledgeAsPrompt()}`;

/** Compact tool output: just what the model needs to talk about a lot. */
function lotForModel(lot: PublicLot) {
  return {
    id: lot.id,
    title: lot.title,
    url: `/lots/${lot.id}`,
    status: lot.status,
    currentPrice: usd(lot.currentPriceCents),
    bids: lot.bidCount,
    closes: lot.endTime.toISOString(),
    location: lot.location,
    condition: lot.condition,
    category: lot.category.name,
    seller: lot.seller.companyName,
    sellerRating: lot.sellerRating ? `${lot.sellerRating.average}/5 (${lot.sellerRating.count} reviews)` : 'no reviews yet',
  };
}

async function runClaude(client: Anthropic, history: ChatTurn[], lotId: string | undefined): Promise<AssistantReply | null> {
  const found = new Map<string, PublicLot>();
  const { categories } = await catalogSnapshot();

  const searchLots = betaZodTool({
    name: 'search_lots',
    description:
      'Search SurplusBid auction lots. Use it for any question about items, availability, prices or categories. Returns up to 6 lots, live ones by default.',
    inputSchema: z.object({
      query: z.string().max(100).optional().describe('Product words to match, e.g. "forklift" or "poweredge"'),
      categorySlug: z.string().optional().describe(`One of: ${categories.map((c) => c.slug).join(', ')}`),
      minPriceUsd: z.number().nonnegative().optional(),
      maxPriceUsd: z.number().positive().optional(),
      location: z.string().max(80).optional().describe('City or two-letter US state code'),
      condition: z.enum(CONDITIONS).optional(),
      status: z.enum(['LIVE', 'SOLD']).optional().describe('LIVE (default) or SOLD for past results'),
      sort: z.enum(SORTS).optional(),
    }),
    run: async (input) => {
      const category = categories.find((c) => c.slug === input.categorySlug);
      const sort = LOTS_SORT_MAP[input.sort ?? 'ending'];
      const result = await browseLots({
        page: 1,
        limit: 6,
        status: input.status ?? 'LIVE',
        sortBy: sort.sortBy,
        sortOrder: sort.sortOrder,
        ...(input.query ? { q: input.query } : {}),
        ...(category ? { categoryId: category.id } : {}),
        ...(input.minPriceUsd !== undefined ? { minPriceCents: Math.round(input.minPriceUsd * 100) } : {}),
        ...(input.maxPriceUsd !== undefined ? { maxPriceCents: Math.round(input.maxPriceUsd * 100) } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.condition ? { condition: input.condition } : {}),
      });
      for (const lot of result.items) found.set(lot.id, lot);
      return JSON.stringify({ total: result.meta.total, lots: result.items.map(lotForModel) });
    },
  });

  const getLot = betaZodTool({
    name: 'get_lot_details',
    description: 'Full details of one lot by id: description, specifications, schedule, bidding and seller.',
    inputSchema: z.object({ lotId: z.string().uuid() }),
    run: async ({ lotId: id }) => {
      try {
        const lot = await getLotDetail(id, undefined);
        if (lot.status === 'DRAFT') return JSON.stringify({ error: 'Lot not found' });
        return JSON.stringify({
          id: lot.id,
          url: `/lots/${lot.id}`,
          title: lot.title,
          description: lot.description.slice(0, 1500),
          specs: lot.specs,
          status: lot.status,
          condition: lot.condition,
          quantity: lot.quantity,
          location: lot.location,
          category: lot.category.name,
          currentPrice: usd(lot.currentPriceCents),
          minimumNextBid: usd(lot.currentPriceCents + lot.bidIncrementCents),
          bidIncrement: usd(lot.bidIncrementCents),
          bids: lot.bidCount,
          opens: lot.startTime.toISOString(),
          closes: lot.endTime.toISOString(),
          deposit: usd(Math.round(lot.startingPriceCents * (env.depositPercent / 100))),
          seller: {
            name: lot.seller.companyName,
            location: lot.seller.location,
            rating: lot.seller.rating,
            lotsSold: lot.seller.lotsSold,
          },
        });
      } catch {
        return JSON.stringify({ error: 'Lot not found' });
      }
    },
  });

  const listCategories = betaZodTool({
    name: 'marketplace_overview',
    description: 'Categories with live lot counts, plus headline marketplace figures.',
    inputSchema: z.object({}),
    run: async () => {
      const [counts, stats] = await Promise.all([
        prisma.lot.groupBy({ by: ['categoryId'], where: { status: 'LIVE', deletedAt: null }, _count: { _all: true } }),
        publicStats(),
      ]);
      const live = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return JSON.stringify({
        categories: categories.map((c) => ({ name: c.name, slug: c.slug, liveLots: live.get(c.id) ?? 0, url: `/lots?categoryId=${c.id}` })),
        stats,
      });
    },
  });

  const context = [`Today is ${new Date().toISOString().slice(0, 10)}.`];
  if (lotId) context.push(`The user is viewing lot ${lotId}. Call get_lot_details when they ask about "this lot".`);

  const final = await client.beta.messages.toolRunner({
    model: AI_MODEL,
    max_tokens: 8000,
    ...FALLBACK_PARAMS,
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: context.join(' ') },
    ],
    tools: [searchLots, getLot, listCategories],
    messages: history.map((t) => ({ role: t.role, content: t.content })),
    max_iterations: 5,
  });

  if (final.stop_reason === 'refusal') {
    return {
      reply: "I can't help with that one. I can find lots, explain bidding and deposits, or walk you through selling on SurplusBid.",
      lots: [],
      suggestions: suggestionsFor(lotId),
      mode: 'ai',
    };
  }

  const text = final.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  if (!text) return null;

  // Show cards for the lots the reply links to; if it links none, for what it last found.
  const linked = [...text.matchAll(/\/lots\/([0-9a-f-]{36})/g)].map((m) => m[1]!);
  const cards = (linked.length ? linked.map((id) => found.get(id)).filter((l): l is PublicLot => !!l) : [...found.values()])
    .slice(0, 4)
    .map(toCard);

  return { reply: text, lots: cards, suggestions: suggestionsFor(lotId), mode: 'ai' };
}

const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|yo|howdy|hiya)\b[\s!.?]*$/i;
const LOT_WORDS =
  /\b(find|show|search|looking for|look for|any|need|want|available|cheapest|under|below|over|between|price|buy|recommend|suggest|lots? (in|for|near)|ending|closing)\b/i;

/** The built-in assistant: knowledge-base answers plus real catalogue search, no model required. */
async function builtInReply(history: ChatTurn[], lotId: string | undefined): Promise<AssistantReply> {
  const question = [...history].reverse().find((t) => t.role === 'user')?.content.trim() ?? '';
  const suggestions = suggestionsFor(lotId);

  if (!question || GREETING.test(question)) {
    return {
      reply:
        "Hi! I'm the SurplusBid Assistant. I can find live lots (try \"forklifts under $25,000 in Texas\") and explain deposits, bidding, payments, verification and selling. What can I help with?",
      lots: [],
      suggestions,
      mode: 'smart',
    };
  }

  // Questions about the lot on screen.
  if (lotId && /\b(this|the) (lot|item|auction|machine|one)\b|minimum bid|next bid|when does it (close|end)|how much/i.test(question)) {
    try {
      const lot = await getLotDetail(lotId, undefined);
      if (lot.status !== 'DRAFT') {
        const minimum = lot.currentPriceCents + lot.bidIncrementCents;
        const deposit = Math.round(lot.startingPriceCents * (env.depositPercent / 100));
        const live = lot.status === 'LIVE';
        return {
          reply: live
            ? `**${lot.title}** is at ${usd(lot.currentPriceCents)} after ${lot.bidCount} bid${lot.bidCount === 1 ? '' : 's'}. The minimum next bid is ${usd(minimum)}, in steps of ${usd(lot.bidIncrementCents)}. It closes ${closeFmt.format(lot.endTime)}, and late bids extend the clock by two minutes. You'll authorize a refundable ${usd(deposit)} deposit hold before your first bid. Pickup is in ${lot.location || 'the location on the listing'}.`
            : `**${lot.title}** is ${lot.status.toLowerCase()}. Its final price was ${usd(lot.currentPriceCents)} after ${lot.bidCount} bid${lot.bidCount === 1 ? '' : 's'}. Browse [similar live lots](/lots?categoryId=${lot.categoryId}).`,
          lots: [],
          suggestions,
          mode: 'smart',
        };
      }
    } catch {
      /* fall through to the general answers */
    }
  }

  const { categories, locations } = await catalogSnapshot();
  const intent = parseSearchHeuristic(question, categories, locations);
  const knowledge = matchKnowledge(question, 2);
  const filters =
    intent.categoryId || intent.maxPriceCents !== undefined || intent.minPriceCents !== undefined || intent.location || intent.condition;
  const wantsLots = LOT_WORDS.test(question) || !!filters || (!knowledge.length && intent.q.length > 0);

  if (wantsLots && (!knowledge.length || filters || /\b(find|show|search|looking)\b/i.test(question))) {
    const sort = LOTS_SORT_MAP[intent.sort ?? 'ending'];
    const result = await browseLots({
      page: 1,
      limit: 4,
      status: intent.status ?? 'LIVE',
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder,
      ...(intent.q ? { q: intent.q } : {}),
      ...(intent.categoryId ? { categoryId: intent.categoryId } : {}),
      ...(intent.minPriceCents !== undefined ? { minPriceCents: intent.minPriceCents } : {}),
      ...(intent.maxPriceCents !== undefined ? { maxPriceCents: intent.maxPriceCents } : {}),
      ...(intent.location ? { location: intent.location } : {}),
      ...(intent.condition ? { condition: intent.condition } : {}),
    });
    const params = new URLSearchParams();
    if (intent.q) params.set('q', intent.q);
    if (intent.categoryId) params.set('categoryId', intent.categoryId);
    if (intent.minPriceCents !== undefined) params.set('minPrice', String(Math.round(intent.minPriceCents / 100)));
    if (intent.maxPriceCents !== undefined) params.set('maxPrice', String(Math.round(intent.maxPriceCents / 100)));
    if (intent.location) params.set('location', intent.location);
    if (intent.condition) params.set('condition', intent.condition);
    if (intent.status === 'SOLD') params.set('status', 'SOLD');
    if (intent.sort) params.set('sort', intent.sort);
    const browse = `/lots${params.size ? `?${params}` : ''}`;
    const scope = intent.explanation || 'your search';

    if (!result.items.length) {
      return {
        reply: `I couldn't find live lots matching ${scope} right now. Try a wider price range or another location, or [browse all live auctions](/lots). New lots are listed every week.`,
        lots: [],
        suggestions,
        mode: 'smart',
      };
    }
    const lines = result.items.map(
      (l) => `- [${l.title}](/lots/${l.id}): ${usd(l.currentPriceCents)}, ${l.location || l.category.name}`
    );
    return {
      reply: `Here ${result.meta.total === 1 ? 'is the 1 lot' : `are ${Math.min(result.items.length, result.meta.total)} of ${result.meta.total} lots`} matching ${scope}:\n${lines.join('\n')}\n\n[See all results](${browse})`,
      lots: result.items.map(toCard),
      suggestions,
      mode: 'smart',
    };
  }

  if (knowledge.length) {
    const [first, second] = knowledge;
    const more = second && second.id !== first!.id ? `\n\n**${second.title}:** ${second.answer}` : '';
    const link = first!.link ? `\n\n[${first!.link.label}](${first!.link.href})` : '';
    return { reply: `${first!.answer}${more}${link}`, lots: [], suggestions, mode: 'smart' };
  }

  return {
    reply: `I can help with finding lots and with how SurplusBid works: ${KNOWLEDGE.slice(0, 6)
      .map((k) => k.title.toLowerCase())
      .join(', ')}. Try asking "show me servers ending soon" or "when is my deposit released?". For anything else, [contact our team](/contact).`,
    lots: [],
    suggestions,
    mode: 'smart',
  };
}

/** Claude when configured, the built-in assistant otherwise (or if the model call fails). */
export async function chat(turns: ChatTurn[], lotId?: string): Promise<AssistantReply> {
  // The model's conversation must open with the user; drop any leading assistant greeting.
  const firstUser = turns.findIndex((t) => t.role === 'user');
  const history = firstUser > 0 ? turns.slice(firstUser) : turns;
  if (llm) {
    try {
      const reply = await runClaude(llm, history, lotId);
      if (reply) return reply;
    } catch (err) {
      logAiError('assistant', err);
    }
  }
  return builtInReply(history, lotId);
}
