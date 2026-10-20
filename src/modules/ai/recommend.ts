import { prisma } from '../../config/prisma';
import { decorateLots, PUBLIC_LOT_SELECT, type PublicLot, type PublicLotRow } from '../lots/lots.service';
import { addInto, buildIdf, cosine, tfidf, tokenize, type Vector } from './text';

export interface ScoredLot extends PublicLot {
  reason: string;
  score: number;
}

const HOUR_MS = 3_600_000;
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * Live lots ranked by recent activity: bids and distinct bidders in the last
 * 24 hours weigh most, then views, lifetime interest and an ending-soon boost.
 */
export async function trendingLots(limit: number, excludeIds: string[] = []): Promise<ScoredLot[]> {
  const activity = await prisma.$queryRaw<
    { id: string; bids24: bigint; bidders24: bigint; bidsTotal: bigint; views24: bigint; viewCount: number; endTime: Date }[]
  >`
    SELECT l.id, l."viewCount", l."endTime",
      (SELECT COUNT(*) FROM "Bid" b WHERE b."lotId" = l.id AND b."createdAt" >= NOW() - interval '24 hours') AS "bids24",
      (SELECT COUNT(DISTINCT b."buyerId") FROM "Bid" b WHERE b."lotId" = l.id AND b."createdAt" >= NOW() - interval '24 hours') AS "bidders24",
      (SELECT COUNT(*) FROM "Bid" b WHERE b."lotId" = l.id) AS "bidsTotal",
      (SELECT COUNT(*) FROM "LotView" v WHERE v."lotId" = l.id AND v."createdAt" >= NOW() - interval '24 hours') AS "views24"
    FROM "Lot" l
    WHERE l.status = 'LIVE' AND l."deletedAt" IS NULL AND l."endTime" > NOW()`;

  const now = Date.now();
  const scored = activity
    .filter((a) => !excludeIds.includes(a.id))
    .map((a) => {
      const bids24 = num(a.bids24);
      const bidders24 = num(a.bidders24);
      const bidsTotal = num(a.bidsTotal);
      const views24 = num(a.views24);
      const hoursLeft = (a.endTime.getTime() - now) / HOUR_MS;
      const endingBoost = hoursLeft <= 24 ? 2 : hoursLeft <= 72 ? 1 : 0;
      const score =
        3 * bids24 + 2 * bidders24 + 0.5 * views24 + 1.5 * Math.log1p(bidsTotal) + 0.3 * Math.log1p(a.viewCount) + endingBoost;
      let reason: string;
      if (bids24 >= 3) reason = `${bids24} bids in the last 24 hours`;
      else if (bidders24 >= 2) reason = `${bidders24} businesses bidding today`;
      else if (views24 >= 10) reason = `${views24} views today`;
      else if (hoursLeft <= 24 && bidsTotal > 0) reason = 'Closing soon with active bidding';
      else if (bidsTotal > 0) reason = `${bidsTotal} bid${bidsTotal === 1 ? '' : 's'} so far`;
      else reason = 'Fresh listing drawing attention';
      return { id: a.id, score, reason };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);

  if (!scored.length) return [];
  const rows = await prisma.lot.findMany({ where: { id: { in: scored.map((s) => s.id) } }, select: PUBLIC_LOT_SELECT });
  const lots = new Map((await decorateLots(rows)).map((l) => [l.id, l]));
  return scored.flatMap((s) => {
    const lot = lots.get(s.id);
    return lot ? [{ ...lot, reason: s.reason, score: Math.round(s.score * 100) / 100 }] : [];
  });
}

const docTokens = (lot: { title: string; description: string }) => tokenize(`${lot.title} ${lot.title} ${lot.description}`);

/**
 * Content-based recommendations. The visitor's signals (lots they bid on,
 * plus the recently viewed and watched lots their browser sends) build a
 * profile: TF-IDF keywords, category affinity and a typical price. Live lots
 * are scored against it, lightly diversified by category, and each pick says
 * why it was chosen. With no signals at all it falls back to trending.
 */
export async function recommendLots(opts: { userId?: string; seedIds: string[]; limit: number }) {
  const bidRows = opts.userId
    ? await prisma.bid.findMany({
        where: { buyerId: opts.userId },
        select: { lotId: true },
        orderBy: { createdAt: 'desc' },
        distinct: ['lotId'],
        take: 30,
      })
    : [];
  const weights = new Map<string, number>();
  opts.seedIds.slice(0, 30).forEach((id, i) => weights.set(id, Math.max(weights.get(id) ?? 0, 2 - i * 0.04)));
  for (const { lotId } of bidRows) weights.set(lotId, (weights.get(lotId) ?? 0) + 3);

  if (weights.size === 0) return { strategy: 'trending' as const, items: await trendingLots(opts.limit) };

  const signalIds = [...weights.keys()];
  const [signals, candidates] = await Promise.all([
    prisma.lot.findMany({
      where: { id: { in: signalIds }, deletedAt: null },
      select: { id: true, title: true, description: true, categoryId: true, currentPriceCents: true, category: { select: { name: true } } },
    }),
    prisma.lot.findMany({
      where: { status: 'LIVE', deletedAt: null, endTime: { gt: new Date() }, id: { notIn: signalIds } },
      select: PUBLIC_LOT_SELECT,
      orderBy: { endTime: 'asc' },
      take: 300,
    }),
  ]);
  if (!signals.length || !candidates.length) {
    return { strategy: 'trending' as const, items: await trendingLots(opts.limit, signalIds) };
  }

  const signalDocs = signals.map(docTokens);
  const candidateDocs = candidates.map(docTokens);
  const idf = buildIdf([...signalDocs, ...candidateDocs]);
  const signalVectors = signalDocs.map((d) => tfidf(d, idf));

  const profile: Vector = new Map();
  const categoryAffinity = new Map<string, number>();
  const categoryNames = new Map<string, string>();
  let logPriceSum = 0;
  let weightSum = 0;
  signals.forEach((s, i) => {
    const w = weights.get(s.id) ?? 1;
    addInto(profile, signalVectors[i]!, w);
    categoryAffinity.set(s.categoryId, (categoryAffinity.get(s.categoryId) ?? 0) + w);
    categoryNames.set(s.categoryId, s.category.name);
    logPriceSum += Math.log(Math.max(s.currentPriceCents, 100)) * w;
    weightSum += w;
  });
  const maxAffinity = Math.max(...categoryAffinity.values());
  const priceCenter = logPriceSum / weightSum;
  const maxBids = Math.max(1, ...candidates.map((c) => c._count.bids));
  const now = Date.now();

  const scored = candidates.map((c, i) => {
    const vector = tfidf(candidateDocs[i]!, idf);
    const similarity = cosine(profile, vector);
    const category = (categoryAffinity.get(c.categoryId) ?? 0) / maxAffinity;
    const price = Math.max(0, 1 - Math.abs(Math.log(Math.max(c.currentPriceCents, 100)) - priceCenter) / Math.log(5));
    const popularity = Math.log1p(c._count.bids) / Math.log1p(maxBids);
    const ending = c.endTime.getTime() - now <= 48 * HOUR_MS ? 1 : 0;
    const parts = { similarity: 0.45 * similarity, category: 0.25 * category, price: 0.15 * price, popularity: 0.1 * popularity };
    const score = parts.similarity + parts.category + parts.price + parts.popularity + 0.05 * ending;

    const top = (Object.entries(parts) as [keyof typeof parts, number][]).sort((a, b) => b[1] - a[1])[0]![0];
    let reason: string;
    if (top === 'similarity' && similarity > 0.08) {
      const closest = signals
        .map((s, j) => ({ s, sim: cosine(signalVectors[j]!, vector) }))
        .sort((a, b) => b.sim - a.sim)[0]!.s;
      reason = `Similar to “${closest.title}”`;
    } else if (category > 0) {
      reason = `Because you're interested in ${categoryNames.get(c.categoryId) ?? c.category.name}`;
    } else if (top === 'price') {
      reason = 'In your usual price range';
    } else {
      reason = 'Popular with other bidders';
    }
    return { row: c, score, reason };
  });

  // Greedy pick with a small penalty for repeating a category, so one interest doesn't fill the row.
  const picked: typeof scored = [];
  const perCategory = new Map<string, number>();
  const pool = [...scored].sort((a, b) => b.score - a.score);
  while (picked.length < opts.limit && pool.length) {
    let bestIndex = 0;
    let bestValue = -1;
    pool.forEach((p, idx) => {
      const value = p.score * 0.85 ** (perCategory.get(p.row.categoryId) ?? 0);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = idx;
      }
    });
    const [choice] = pool.splice(bestIndex, 1);
    picked.push(choice!);
    perCategory.set(choice!.row.categoryId, (perCategory.get(choice!.row.categoryId) ?? 0) + 1);
  }

  const decorated = await decorateLots(picked.map((p) => p.row as PublicLotRow));
  return {
    strategy: 'personalized' as const,
    items: decorated.map((lot, i) => ({
      ...lot,
      reason: picked[i]!.reason,
      score: Math.round(picked[i]!.score * 1000) / 1000,
    })),
  };
}
