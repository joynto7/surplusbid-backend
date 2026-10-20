import { prisma } from '../../config/prisma';

export interface RatingSummary {
  average: number;
  count: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Average rating and review count per seller, in one grouped query. */
export async function ratingsForSellers(sellerIds: string[]): Promise<Map<string, RatingSummary>> {
  const unique = [...new Set(sellerIds)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.review.groupBy({
    by: ['sellerId'],
    where: { sellerId: { in: unique } },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.sellerId, { average: round1(r._avg.rating ?? 0), count: r._count._all }]));
}

/** Average, count and the 1–5 star distribution for one seller. */
export async function ratingBreakdown(sellerId: string) {
  const rows = await prisma.review.groupBy({
    by: ['rating'],
    where: { sellerId },
    _count: { _all: true },
  });
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const row of rows) {
    const stars = row.rating as 1 | 2 | 3 | 4 | 5;
    distribution[stars] = row._count._all;
    total += row._count._all;
    sum += row.rating * row._count._all;
  }
  return { average: total ? round1(sum / total) : 0, count: total, distribution };
}
