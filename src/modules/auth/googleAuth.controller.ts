import { Request, Response } from 'express';
import { User } from '@prisma/client';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';

export function googleCallback(req: Request, res: Response) {
  const user = req.user as unknown as User;
  const accessToken = signAccessToken({ id: user.id, role: user.role });
  const refreshToken = signRefreshToken({ id: user.id });
  res.redirect(`${process.env.CORS_ORIGIN}/oauth-callback?accessToken=${accessToken}&refreshToken=${refreshToken}`);
}
