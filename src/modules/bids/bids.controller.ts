import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { sendSuccess } from '../../utils/response';
import { createDepositHold, placeBid, getBidHistory, getMyBids } from './bids.service';
import { paginationQuerySchema } from './bids.query';

export const deposit = asyncHandler(async (req: Request, res: Response) => {
  const hold = await createDepositHold(req.params.id as string, req.user!.id);
  sendSuccess(res, 201, 'Deposit authorized', hold);
});

export const bid = asyncHandler(async (req: Request, res: Response) => {
  const result = await placeBid(req.params.id as string, req.user!.id, req.body.amountCents);
  sendSuccess(res, 201, 'Bid placed', result);
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const parsed = paginationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ApiError(422, 'Validation failed', errors);
  }
  const result = await getBidHistory(req.params.id as string, parsed.data.page, parsed.data.limit);
  sendSuccess(res, 200, 'Bid history fetched', result);
});

export const myBids = asyncHandler(async (req: Request, res: Response) => {
  const parsed = paginationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ApiError(422, 'Validation failed', errors);
  }
  const result = await getMyBids(req.user!.id, parsed.data.page, parsed.data.limit);
  sendSuccess(res, 200, 'Your bids fetched', result);
});
