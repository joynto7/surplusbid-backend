import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { createDispute, listAllDisputes, listMyDisputes, resolveDispute } from './disputes.service';

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await createDispute(req.user!.id, req.body);
  sendSuccess(res, 201, 'Dispute filed', dispute);
});

export const resolve = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await resolveDispute(req.params.id as string, req.user!.id, req.body);
  sendSuccess(res, 200, 'Dispute resolved', dispute);
});

export const mine = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = parseOr422(listSchema, req.query);
  sendSuccess(res, 200, 'Your disputes fetched', await listMyDisputes(req.user!.id, page, limit));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const q = parseOr422(listSchema, req.query);
  sendSuccess(res, 200, 'Disputes fetched', await listAllDisputes(q.page, q.limit, q.status, q.q));
});
