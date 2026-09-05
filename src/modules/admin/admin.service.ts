import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

export async function listUsers(page: number, limit: number, verificationStatus?: string, role?: string) {
  const where = {
    deletedAt: null,
    ...(verificationStatus ? { verificationStatus: verificationStatus as never } : {}),
    ...(role ? { role: role as never } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { id: true, email: true, role: true, companyName: true, verificationStatus: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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
  const [activeLots, openDisputes, verifiedSellers, totalGmvCents] = await Promise.all([
    prisma.lot.count({ where: { status: 'LIVE', deletedAt: null } }),
    prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
    prisma.user.count({ where: { role: 'SELLER', verificationStatus: 'VERIFIED' } }),
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountCents: true } }),
  ]);
  return { activeLots, openDisputes, verifiedSellers, totalGmvCents: totalGmvCents._sum.amountCents ?? 0 };
}

export async function listAuditLogs(page: number, limit: number, entityType?: string) {
  const where = entityType ? { entityType } : {};
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
