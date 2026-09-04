import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createDepositHold, placeBid } from './bids.service';

export const deposit = asyncHandler(async (req: Request, res: Response) => {
  const hold = await createDepositHold(req.params.id as string, req.user!.id);
  sendSuccess(res, 201, 'Deposit authorized', hold);
});

export const bid = asyncHandler(async (req: Request, res: Response) => {
  const result = await placeBid(req.params.id as string, req.user!.id, req.body.amountCents);
  sendSuccess(res, 201, 'Bid placed', result);
});
