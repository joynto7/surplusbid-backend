import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { redis } from '../../config/redis';
import { ApiError } from '../../utils/ApiError';
import { pageMeta } from '../../utils/pagination';
import { ratingsForSellers } from '../reviews/ratings';
import { browseLotsSchema } from './lots.query';

const LOT_LIST_SELECT = {
  id: true, title: true, images: true, categoryId: true, status: true, location: true, viewCount: true,
  startingPriceCents: true, currentHighestBidAmountCents: true, currentPriceCents: true, endTime: true,
  createdAt: true, _count: { select: { bids: true } },
} as const;

export async function findLotById(lotId: string) {
  const lot = await prisma.lot.findFirst({ where: { id: lotId, deletedAt: null } });
  if (!lot) throw new ApiError(404, 'Lot not found');
  return lot;
}

export async function getOwnedDraftOr404(lotId: string, sellerId: string) {
  const lot = await findLotById(lotId);
  if (lot.sellerId !== sellerId) throw new ApiError(403, 'You do not own this lot');
  return lot;
}

export function createLot(sellerId: string, data: Record<string, unknown>, images: string[]) {
  return prisma.lot.create({
    data: { ...data, sellerId, images } as never,
  });
}

export async function updateDraftLot(lotId: string, sellerId: string, data: Record<string, unknown>) {
  const lot = await getOwnedDraftOr404(lotId, sellerId);
  if (lot.status !== 'DRAFT') throw new ApiError(409, 'Only draft lots can be edited');
  return prisma.lot.update({ where: { id: lotId }, data: data as never });
}

export async function softDeleteLot(lotId: string, sellerId: string) {
  await getOwnedDraftOr404(lotId, sellerId);
  return prisma.lot.update({ where: { id: lotId }, data: { deletedAt: new Date() } });
}

export async function publishLot(lotId: string, sellerId: string) {
  const lot = await getOwnedDraftOr404(lotId, sellerId);
  if (lot.status !== 'DRAFT') throw new ApiError(409, 'Only draft lots can be published');
  return prisma.lot.update({ where: { id: lotId }, data: { status: 'LIVE' } });
}

export async function listMyLots(sellerId: string) {
  const lots = await prisma.lot.findMany({
    where: { sellerId, deletedAt: null },
    select: LOT_LIST_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  return lots.map(({ _count, ...lot }) => ({ ...lot, bidCount: _count.bids }));
}

/** Everything a lot card needs: the lot, its category, its seller and the bid count. */
export const PUBLIC_LOT_SELECT = {
  id: true, title: true, description: true, images: true, condition: true, quantity: true,
  categoryId: true, sellerId: true, status: true, startingPriceCents: true, bidIncrementCents: true,
  currentHighestBidAmountCents: true, currentPriceCents: true, startTime: true, endTime: true, createdAt: true,
  location: true, viewCount: true,
  category: { select: { id: true, name: true, slug: true } },
  seller: { select: { id: true, companyName: true, location: true, verificationStatus: true } },
  _count: { select: { bids: true } },
} satisfies Prisma.LotSelect;

export type PublicLotRow = Prisma.LotGetPayload<{ select: typeof PUBLIC_LOT_SELECT }>;

/** Flattens the bid count and attaches each seller's rating. */
export async function decorateLots(rows: PublicLotRow[]) {
  const ratings = await ratingsForSellers(rows.map((r) => r.sellerId));
  return rows.map(({ _count, ...lot }) => ({
    ...lot,
    bidCount: _count.bids,
    sellerRating: ratings.get(lot.sellerId) ?? null,
  }));
}

export type PublicLot = Awaited<ReturnType<typeof decorateLots>>[number];

type BrowseQuery = z.infer<typeof browseLotsSchema>;

/** Plural → stem, so "forklifts" finds "Forklift" and "lathes" finds "Lathe" (matching is by substring). */
export function stem(term: string) {
  const t = term.toLowerCase();
  if (t.length <= 4 || t.endsWith('ss')) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (/(x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/**
 * Public catalogue query. Drafts are only listed for admins; everyone else
 * sees published lots, whatever filters they send.
 */
export function buildLotWhere(
  query: Omit<BrowseQuery, 'page' | 'limit' | 'sortBy' | 'sortOrder'>,
  includeDrafts = false,
  searchDescriptions = false
) {
  const and: Prisma.LotWhereInput[] = [{ deletedAt: null }];
  if (query.status) and.push({ status: query.status });
  if (!includeDrafts) and.push({ status: { not: 'DRAFT' } });
  if (query.categoryId) and.push({ categoryId: query.categoryId });
  if (query.sellerId) and.push({ sellerId: query.sellerId });
  if (query.ids) and.push({ id: { in: query.ids } });
  if (query.minPriceCents !== undefined) and.push({ currentPriceCents: { gte: query.minPriceCents } });
  if (query.maxPriceCents !== undefined) and.push({ currentPriceCents: { lte: query.maxPriceCents } });
  if (query.location) {
    // A two-letter state code matches the end of "City, ST", so "CA" never matches "Chicago".
    and.push(
      /^[A-Za-z]{2}$/.test(query.location)
        ? { location: { endsWith: `, ${query.location.toUpperCase()}` } }
        : { location: { contains: query.location, mode: 'insensitive' } }
    );
  }
  if (query.condition) and.push({ condition: { contains: query.condition, mode: 'insensitive' } });
  if (query.q) {
    // Every word must appear somewhere (title, location or category), so "forklift texas"
    // narrows instead of widening. Descriptions are a second pass: they mention things
    // like "forklift loading" that would otherwise flood a search for forklifts.
    for (const term of query.q.split(/\s+/).filter(Boolean).slice(0, 6).map(stem)) {
      and.push({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { location: { contains: term, mode: 'insensitive' } },
          { category: { name: { contains: term, mode: 'insensitive' } } },
          ...(searchDescriptions ? [{ description: { contains: term, mode: 'insensitive' as const } }] : []),
        ],
      });
    }
  }
  return { AND: and } satisfies Prisma.LotWhereInput;
}

function lotOrderBy(sortBy: BrowseQuery['sortBy'], sortOrder: BrowseQuery['sortOrder']): Prisma.LotOrderByWithRelationInput[] {
  // The id tiebreaker keeps pagination stable when many lots share a sort value.
  if (sortBy === 'popularity') return [{ bids: { _count: sortOrder } }, { viewCount: sortOrder }, { id: 'asc' }];
  if (sortBy === 'currentHighestBidAmountCents') {
    return [{ currentHighestBidAmountCents: { sort: sortOrder, nulls: 'last' } }, { id: 'asc' }];
  }
  return [{ [sortBy]: sortOrder }, { id: 'asc' }];
}

export async function browseLots(query: BrowseQuery, viewerRole?: string) {
  const includeDrafts = viewerRole === 'ADMIN';
  let where = buildLotWhere(query, includeDrafts);
  // No title matches? Look in descriptions too ("xeon", "fanuc", "nist").
  if (query.q && (await prisma.lot.count({ where })) === 0) where = buildLotWhere(query, includeDrafts, true);
  const [rows, total] = await Promise.all([
    prisma.lot.findMany({
      where,
      select: PUBLIC_LOT_SELECT,
      orderBy: lotOrderBy(query.sortBy, query.sortOrder),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.lot.count({ where }),
  ]);

  return { items: await decorateLots(rows), meta: pageMeta(query.page, query.limit, total) };
}

export async function getLotDetail(lotId: string, requesterId: string | undefined) {
  const cacheKey = `lot:${lotId}:highestBid`;
  const lot = await prisma.lot.findFirst({
    where: { id: lotId, deletedAt: null },
    include: {
      category: { select: { id: true, name: true, slug: true } },
      seller: {
        select: {
          id: true, companyName: true, location: true, bio: true, verificationStatus: true, createdAt: true,
        },
      },
      _count: { select: { bids: true } },
    },
  });
  if (!lot) throw new ApiError(404, 'Lot not found');

  const [cachedHighest, ratings, lotsSold, liveLots] = await Promise.all([
    redis.get(cacheKey),
    ratingsForSellers([lot.sellerId]),
    prisma.lot.count({ where: { sellerId: lot.sellerId, status: 'SOLD', deletedAt: null } }),
    prisma.lot.count({ where: { sellerId: lot.sellerId, status: 'LIVE', deletedAt: null } }),
  ]);
  const currentHighestBidAmountCents = cachedHighest !== null ? Number(cachedHighest) : lot.currentHighestBidAmountCents;

  const { reservePriceCents, _count, seller, ...publicFields } = lot;
  const isOwner = requesterId === lot.sellerId;
  return {
    ...publicFields,
    currentHighestBidAmountCents,
    currentPriceCents: currentHighestBidAmountCents ?? lot.startingPriceCents,
    bidCount: _count.bids,
    seller: { ...seller, rating: ratings.get(lot.sellerId) ?? null, lotsSold, liveLots },
    // The reserve stays private to the seller: neither the amount nor whether bidding has reached it.
    ...(isOwner
      ? {
          reservePriceCents,
          reserveMet: currentHighestBidAmountCents !== null && currentHighestBidAmountCents >= reservePriceCents,
        }
      : {}),
  };
}

/** Same-category live lots first, then live lots in a similar price band, then anything live. */
export async function getRelatedLots(lotId: string, limit: number) {
  const lot = await findLotById(lotId);
  const picked: PublicLotRow[] = [];
  const exclude = () => [lotId, ...picked.map((p) => p.id)];
  const take = async (where: Prisma.LotWhereInput) => {
    if (picked.length >= limit) return;
    const rows = await prisma.lot.findMany({
      where: { deletedAt: null, status: 'LIVE', id: { notIn: exclude() }, ...where },
      select: PUBLIC_LOT_SELECT,
      orderBy: [{ endTime: 'asc' }, { id: 'asc' }],
      take: limit - picked.length,
    });
    picked.push(...rows);
  };

  const price = lot.currentPriceCents || lot.startingPriceCents;
  await take({ categoryId: lot.categoryId });
  await take({ currentPriceCents: { gte: Math.floor(price / 4), lte: price * 4 } });
  await take({});
  return decorateLots(picked);
}

const VIEW_DEDUPE_SECONDS = 30 * 60;

/**
 * Counts a lot page view at most once per viewer per half hour. Sellers
 * looking at their own lots don't count. Uses a raw UPDATE so a view never
 * touches the lot's updatedAt.
 */
export async function recordLotView(lotId: string, viewer: { userId?: string; viewerId?: string; fallback: string }) {
  const lot = await prisma.lot.findFirst({
    where: { id: lotId, deletedAt: null, status: { not: 'DRAFT' } },
    select: { id: true, sellerId: true },
  });
  if (!lot) throw new ApiError(404, 'Lot not found');
  if (viewer.userId && viewer.userId === lot.sellerId) return { counted: false };

  const who = viewer.userId ?? viewer.viewerId ?? viewer.fallback;
  const fresh = await redis.set(`lotview:${lotId}:${who}`, '1', 'EX', VIEW_DEDUPE_SECONDS, 'NX');
  if (!fresh) return { counted: false };

  await prisma.$transaction([
    prisma.lotView.create({ data: { lotId, userId: viewer.userId ?? null } }),
    prisma.$executeRaw`UPDATE "Lot" SET "viewCount" = "viewCount" + 1 WHERE id = ${lotId}`,
  ]);
  return { counted: true };
}
