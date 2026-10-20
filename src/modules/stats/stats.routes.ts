import { Request, Response, Router } from 'express';
import { prisma } from '../../config/prisma';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';

/** Headline marketplace figures for the public home page. */
export async function publicStats() {
  const [liveLots, soldLots, closedLots, verifiedBusinesses, totalBids, gmv, categories, reviews] = await Promise.all([
    prisma.lot.count({ where: { status: 'LIVE', deletedAt: null } }),
    prisma.lot.count({ where: { status: 'SOLD', deletedAt: null } }),
    prisma.lot.count({ where: { status: { in: ['SOLD', 'UNSOLD'] }, deletedAt: null } }),
    prisma.user.count({ where: { role: { in: ['BUYER', 'SELLER'] }, verificationStatus: 'VERIFIED', deletedAt: null } }),
    prisma.bid.count(),
    prisma.lot.aggregate({ where: { status: 'SOLD', deletedAt: null }, _sum: { currentHighestBidAmountCents: true } }),
    prisma.category.count(),
    prisma.review.aggregate({ _avg: { rating: true }, _count: { _all: true } }),
  ]);
  return {
    liveLots,
    soldLots,
    verifiedBusinesses,
    totalBids,
    categories,
    gmvCents: gmv._sum.currentHighestBidAmountCents ?? 0,
    sellThroughRate: closedLots ? Math.round((soldLots / closedLots) * 100) : 0,
    averageRating: Math.round((reviews._avg.rating ?? 0) * 10) / 10,
    reviewCount: reviews._count._all,
  };
}

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, 200, 'Marketplace stats fetched', await publicStats());
  })
);

export default router;
