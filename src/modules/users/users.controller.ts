import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { getMe, submitVerification, updateMe } from './users.service';

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = await getMe(req.user!.id);
  sendSuccess(res, 200, 'Profile fetched', user);
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await updateMe(req.user!.id, req.body);
  sendSuccess(res, 200, 'Profile updated', user);
});

export const verify = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File & { path: string };
  if (!file) throw new ApiError(422, 'Verification document is required');
  const user = await submitVerification(req.user!.id, file.path);
  sendSuccess(res, 200, 'Verification submitted for review', user);
});
