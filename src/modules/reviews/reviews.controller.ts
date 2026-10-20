import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { createReview, listMyReviews, listReviewableLots, listSellerReviews } from './reviews.service';
import { reviewListQuerySchema } from './reviews.validation';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const review = await createReview(req.user!.id, req.body);
  sendSuccess(res, 201, 'Thanks for your review', review);
});

export const mine = asyncHandler(async (req: Request, res: Response) => {
  const result = await listMyReviews(req.user!.id, parseOr422(reviewListQuerySchema, req.query));
  sendSuccess(res, 200, 'Your reviews fetched', result);
});

export const reviewable = asyncHandler(async (req: Request, res: Response) => {
  const lots = await listReviewableLots(req.user!.id);
  sendSuccess(res, 200, 'Lots awaiting your review', lots);
});

export const received = asyncHandler(async (req: Request, res: Response) => {
  const result = await listSellerReviews(req.user!.id, parseOr422(reviewListQuerySchema, req.query));
  sendSuccess(res, 200, 'Reviews of your business fetched', result);
});
