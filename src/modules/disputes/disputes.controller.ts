import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createDispute, resolveDispute } from './disputes.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await createDispute(req.user!.id, req.body);
  sendSuccess(res, 201, 'Dispute filed', dispute);
});

export const resolve = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await resolveDispute(req.params.id, req.user!.id, req.body);
  sendSuccess(res, 200, 'Dispute resolved', dispute);
});
