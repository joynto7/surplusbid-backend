import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { chat as runChat } from './assistant';
import { recommendationsQuerySchema, searchIntentSchema, suggestQuerySchema, trendingQuerySchema } from './ai.validation';
import { adminInsights } from './insights';
import { listingAssist } from './listing';
import { recommendLots, trendingLots } from './recommend';
import { parseSearch } from './searchIntent';
import { suggest } from './suggest';

export const chat = asyncHandler(async (req: Request, res: Response) => {
  const reply = await runChat(req.body.messages, req.body.lotId);
  sendSuccess(res, 200, 'Assistant replied', reply);
});

export const suggestions = asyncHandler(async (req: Request, res: Response) => {
  const { q } = parseOr422(suggestQuerySchema, req.query);
  sendSuccess(res, 200, 'Suggestions fetched', await suggest(q));
});

export const searchIntent = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, 200, 'Search understood', await parseSearch(req.body.q));
});

export const recommendations = asyncHandler(async (req: Request, res: Response) => {
  const { seed, limit } = parseOr422(recommendationsQuerySchema, req.query);
  const result = await recommendLots({
    ...(req.user?.role === 'BUYER' ? { userId: req.user.id } : {}),
    seedIds: seed ?? [],
    limit,
  });
  sendSuccess(res, 200, 'Recommendations fetched', result);
});

export const trending = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = parseOr422(trendingQuerySchema, req.query);
  sendSuccess(res, 200, 'Trending lots fetched', await trendingLots(limit));
});

export const listing = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, 200, 'Listing draft ready', await listingAssist(req.body));
});

export const insights = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, 200, 'Insights computed', await adminInsights());
});
