import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { updateProfileSchema } from './users.validation';

const SAFE_FIELDS = {
  id: true, email: true, role: true, companyName: true, taxId: true,
  verificationStatus: true, authProvider: true, createdAt: true,
  contactName: true, phone: true, location: true, bio: true,
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: SAFE_FIELDS });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

/** Empty strings clear the optional profile fields. */
export async function updateMe(userId: string, data: z.infer<typeof updateProfileSchema>) {
  const clean = Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, v === '' && k !== 'companyName' ? null : v])
  );
  return prisma.user.update({ where: { id: userId }, data: clean, select: SAFE_FIELDS });
}

export async function submitVerification(userId: string, docUrl: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'PENDING', verificationDocUrl: docUrl },
    select: SAFE_FIELDS,
  });
}
