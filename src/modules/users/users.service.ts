import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

const SAFE_FIELDS = {
  id: true, email: true, role: true, companyName: true, taxId: true,
  verificationStatus: true, authProvider: true, createdAt: true,
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: SAFE_FIELDS });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

export async function updateMe(userId: string, data: { companyName?: string; taxId?: string }) {
  return prisma.user.update({ where: { id: userId }, data, select: SAFE_FIELDS });
}

export async function submitVerification(userId: string, docUrl: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'PENDING', verificationDocUrl: docUrl },
    select: SAFE_FIELDS,
  });
}
