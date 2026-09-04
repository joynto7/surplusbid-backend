import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { loginUser, registerUser } from './auth.service';
import { verifyRefreshToken, signAccessToken } from '../../utils/jwt';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await registerUser(req.body);
  sendSuccess(res, 201, 'Registration successful', result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await loginUser(req.body);
  sendSuccess(res, 200, 'Login successful', result);
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken: token } = req.body;
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }
  const user = await prisma.user.findFirst({ where: { id: payload.id, deletedAt: null } });
  if (!user) throw new ApiError(401, 'Invalid or expired refresh token');

  const accessToken = signAccessToken({ id: user.id, role: user.role });
  sendSuccess(res, 200, 'Token refreshed', { accessToken });
});

export const logout = asyncHandler(async (_req: Request, res: Response) => {
  // Stateless JWTs: logout is client-side (discard tokens). Nothing to invalidate server-side in v1.
  sendSuccess(res, 200, 'Logged out', {});
});
