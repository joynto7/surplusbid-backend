import bcrypt from 'bcrypt';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';

export async function registerUser(input: { email: string; password: string; role: 'BUYER' | 'SELLER'; companyName: string }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new ApiError(409, 'Email already registered');

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      role: input.role,
      companyName: input.companyName,
    },
    select: { id: true, email: true, role: true },
  });

  return {
    user,
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refreshToken: signRefreshToken({ id: user.id }),
  };
}

export async function loginUser(input: { email: string; password: string }) {
  const user = await prisma.user.findFirst({ where: { email: input.email, deletedAt: null } });
  if (!user || !user.passwordHash) throw new ApiError(401, 'Invalid email or password');

  const matches = await bcrypt.compare(input.password, user.passwordHash);
  if (!matches) throw new ApiError(401, 'Invalid email or password');

  return {
    user: { id: user.id, email: user.email, role: user.role },
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refreshToken: signRefreshToken({ id: user.id }),
  };
}
