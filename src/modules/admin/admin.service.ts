import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { pageMeta } from '../../utils/pagination';

export async function listUsers(page: number, limit: number, verificationStatus?: string, role?: string, q?: string) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(verificationStatus ? { verificationStatus: verificationStatus as never } : {}),
    ...(role ? { role: role as never } : {}),
    ...(q
      ? {
          OR: [
            { companyName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, email: true, role: true, companyName: true, verificationStatus: true, createdAt: true,
        location: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { items, meta: pageMeta(page, limit, total) };
}

export async function verifyUser(userId: string, adminId: string, verificationStatus: 'VERIFIED' | 'REJECTED') {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus },
    select: { id: true, email: true, role: true, companyName: true, verificationStatus: true },
  });

  await prisma.auditLog.create({
    data: { actorId: adminId, action: 'VERIFY_USER', entityType: 'User', entityId: userId, metadata: { verificationStatus } },
  });

  return updated;
}

export async function getDashboardStats() {
  const [
    activeLots, openDisputes, verifiedSellers, totalGmvCents, soldGmv, totalUsers, totalBids, newMessages,
    reviews, subscribers, pendingVerifications,
  ] = await Promise.all([
    prisma.lot.count({ where: { status: 'LIVE', deletedAt: null } }),
    prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
    prisma.user.count({ where: { role: 'SELLER', verificationStatus: 'VERIFIED' } }),
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountCents: true } }),
    prisma.lot.aggregate({ where: { status: 'SOLD', deletedAt: null }, _sum: { currentHighestBidAmountCents: true } }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.bid.count(),
    prisma.contactMessage.count({ where: { status: 'NEW' } }),
    prisma.review.aggregate({ _avg: { rating: true }, _count: { _all: true } }),
    prisma.newsletterSubscriber.count(),
    prisma.user.count({ where: { verificationStatus: 'PENDING', deletedAt: null } }),
  ]);
  return {
    activeLots,
    openDisputes,
    verifiedSellers,
    totalGmvCents: totalGmvCents._sum.amountCents ?? 0,
    soldGmvCents: soldGmv._sum.currentHighestBidAmountCents ?? 0,
    totalUsers,
    totalBids,
    newMessages,
    pendingVerifications,
    reviewCount: reviews._count._all,
    averageRating: Math.round((reviews._avg.rating ?? 0) * 10) / 10,
    subscribers,
  };
}

export async function listAuditLogs(page: number, limit: number, entityType?: string) {
  const where = entityType ? { entityType } : {};
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, meta: pageMeta(page, limit, total) };
}

export async function listMessages(page: number, limit: number, status?: string, q?: string) {
  const where: Prisma.ContactMessageWhereInput = {
    ...(status ? { status: status as never } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { message: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total, counts] = await Promise.all([
    prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.contactMessage.count({ where }),
    prisma.contactMessage.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  return {
    items,
    meta: pageMeta(page, limit, total),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
}

export async function updateMessageStatus(id: string, status: 'NEW' | 'READ' | 'ARCHIVED') {
  const message = await prisma.contactMessage.findUnique({ where: { id } });
  if (!message) throw new ApiError(404, 'Message not found');
  return prisma.contactMessage.update({ where: { id }, data: { status } });
}
