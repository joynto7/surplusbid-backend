import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { findLotById } from '../lots/lots.service';

export async function createDispute(raisedById: string, data: { lotId: string; reason: string; description: string }) {
  const lot = await findLotById(data.lotId);
  const isSeller = lot.sellerId === raisedById;
  const isWinningBidder = isSeller
    ? false
    : Boolean(await prisma.bid.findFirst({ where: { lotId: data.lotId, buyerId: raisedById, status: 'WINNING' } }));
  if (!isSeller && !isWinningBidder) throw new ApiError(403, 'You are not a party to this lot');

  return prisma.dispute.create({ data: { ...data, raisedById } });
}

export async function resolveDispute(disputeId: string, resolvedById: string, data: { status: 'RESOLVED' | 'REJECTED'; resolutionNote: string }) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new ApiError(404, 'Dispute not found');

  const updated = await prisma.dispute.update({
    where: { id: disputeId },
    data: { status: data.status, resolutionNote: data.resolutionNote, resolvedById, resolvedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: resolvedById, action: 'RESOLVE_DISPUTE', entityType: 'Dispute', entityId: disputeId, metadata: data },
  });

  return updated;
}

const DISPUTE_SELECT = {
  id: true, lotId: true, raisedById: true, reason: true, description: true, status: true, resolutionNote: true,
  resolvedById: true, createdAt: true, resolvedAt: true,
  lot: { select: { id: true, title: true, images: true, sellerId: true, seller: { select: { companyName: true } } } },
  raisedBy: { select: { id: true, companyName: true, email: true, role: true } },
} as const;

/** Disputes the user raised, or that concern lots they sell. */
export async function listMyDisputes(userId: string, page: number, limit: number) {
  const where = { OR: [{ raisedById: userId }, { lot: { sellerId: userId } }] };
  const [items, total] = await Promise.all([
    prisma.dispute.findMany({ where, select: DISPUTE_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.dispute.count({ where }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function listAllDisputes(page: number, limit: number, status?: string, q?: string) {
  const where = {
    ...(status ? { status: status as never } : {}),
    ...(q
      ? {
          OR: [
            { reason: { contains: q, mode: 'insensitive' as const } },
            { description: { contains: q, mode: 'insensitive' as const } },
            { lot: { title: { contains: q, mode: 'insensitive' as const } } },
            { raisedBy: { companyName: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [items, total, counts] = await Promise.all([
    prisma.dispute.findMany({ where, select: DISPUTE_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.dispute.count({ where }),
    prisma.dispute.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  return {
    items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
}
