import { prisma } from '../../config/prisma';
import { redis } from '../../config/redis';
import { ApiError } from '../../utils/ApiError';
import { browseLotsSchema } from './lots.query';
import { z } from 'zod';

const LOT_LIST_SELECT = {
  id: true, title: true, images: true, categoryId: true, status: true,
  startingPriceCents: true, currentHighestBidAmountCents: true, endTime: true,
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

export function listMyLots(sellerId: string) {
  return prisma.lot.findMany({ where: { sellerId, deletedAt: null }, select: LOT_LIST_SELECT, orderBy: { createdAt: 'desc' } });
}

const PUBLIC_LOT_SELECT = {
  id: true, title: true, description: true, images: true, condition: true, quantity: true,
  categoryId: true, sellerId: true, status: true, startingPriceCents: true, bidIncrementCents: true,
  currentHighestBidAmountCents: true, startTime: true, endTime: true, createdAt: true,
} as const;

export async function browseLots(query: z.infer<typeof browseLotsSchema>) {
  const where = {
    deletedAt: null,
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lot.findMany({
      where,
      select: PUBLIC_LOT_SELECT,
      orderBy: { [query.sortBy]: query.sortOrder },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.lot.count({ where }),
  ]);

  return { items, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
}

export async function getLotDetail(lotId: string, requesterId: string | undefined) {
  const cacheKey = `lot:${lotId}:highestBid`;
  const lot = await findLotById(lotId);

  const cachedHighest = await redis.get(cacheKey);
  const currentHighestBidAmountCents = cachedHighest !== null ? Number(cachedHighest) : lot.currentHighestBidAmountCents;

  const { reservePriceCents, ...publicFields } = lot;
  const isOwner = requesterId === lot.sellerId;
  return { ...publicFields, currentHighestBidAmountCents, ...(isOwner ? { reservePriceCents } : {}) };
}
