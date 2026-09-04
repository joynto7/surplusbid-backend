import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createDepositHold, placeBid, getBidHistory, getMyBids } from './bids.service';

export const deposit = asyncHandler(async (req: Request, res: Response) => {
  const hold = await createDepositHold(req.params.id as string, req.user!.id);
  sendSuccess(res, 201, 'Deposit authorized', hold);
});

export const bid = asyncHandler(async (req: Request, res: Response) => {
  const result = await placeBid(req.params.id as string, req.user!.id, req.body.amountCents);
  sendSuccess(res, 201, 'Bid placed', result);
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await getBidHistory(req.params.id as string, page, limit);
  sendSuccess(res, 200, 'Bid history fetched', result);
});

export const myBids = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await getMyBids(req.user!.id, page, limit);
  sendSuccess(res, 200, 'Your bids fetched', result);
});
