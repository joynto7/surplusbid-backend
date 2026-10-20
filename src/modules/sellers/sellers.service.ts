import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { ratingBreakdown, ratingsForSellers } from '../reviews/ratings';

const SELLER_PUBLIC_SELECT = {
  id: true, companyName: true, location: true, bio: true, verificationStatus: true, createdAt: true,
} as const;

/**
 * Verified sellers ranked by rating (weighted toward sellers with more
 * reviews, so one 5-star review doesn't top the list), then by lots sold.
 */
export async function topSellers(limit: number) {
  const sellers = await prisma.user.findMany({
    where: { role: 'SELLER', verificationStatus: 'VERIFIED', deletedAt: null },
    select: {
      ...SELLER_PUBLIC_SELECT,
      _count: { select: { lots: { where: { status: 'SOLD', deletedAt: null } } } },
    },
  });
  const ratings = await ratingsForSellers(sellers.map((s) => s.id));
  const live = await prisma.lot.groupBy({
    by: ['sellerId'],
    where: { status: 'LIVE', deletedAt: null, sellerId: { in: sellers.map((s) => s.id) } },
    _count: { _all: true },
  });
  const liveBySeller = new Map(live.map((l) => [l.sellerId, l._count._all]));

  // Bayesian average: pulls sellers with few reviews toward a 4.0 prior.
  const PRIOR = 4;
  const PRIOR_WEIGHT = 3;
  return sellers
    .map(({ _count, ...s }) => {
      const rating = ratings.get(s.id) ?? { average: 0, count: 0 };
      const score = (rating.average * rating.count + PRIOR * PRIOR_WEIGHT) / (rating.count + PRIOR_WEIGHT);
      return { ...s, rating, lotsSold: _count.lots, liveLots: liveBySeller.get(s.id) ?? 0, score };
    })
    .filter((s) => s.rating.count > 0 || s.lotsSold > 0)
    .sort((a, b) => b.score - a.score || b.lotsSold - a.lotsSold)
    .slice(0, limit)
    .map(({ score: _score, ...s }) => s);
}

export async function sellerProfile(sellerId: string) {
  const seller = await prisma.user.findFirst({
    where: { id: sellerId, role: 'SELLER', deletedAt: null },
    select: SELLER_PUBLIC_SELECT,
  });
  if (!seller) throw new ApiError(404, 'Seller not found');
  const [rating, lotsSold, liveLots] = await Promise.all([
    ratingBreakdown(sellerId),
    prisma.lot.count({ where: { sellerId, status: 'SOLD', deletedAt: null } }),
    prisma.lot.count({ where: { sellerId, status: 'LIVE', deletedAt: null } }),
  ]);
  return { ...seller, rating, lotsSold, liveLots };
}
