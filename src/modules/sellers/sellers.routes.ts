import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { listSellerReviews } from '../reviews/reviews.service';
import { reviewListQuerySchema } from '../reviews/reviews.validation';
import { sellerProfile, topSellers } from './sellers.service';

const router = Router();

router.get(
  '/top',
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = parseOr422(z.object({ limit: z.coerce.number().int().positive().max(24).default(6) }), req.query);
    sendSuccess(res, 200, 'Top sellers fetched', await topSellers(limit));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, 200, 'Seller fetched', await sellerProfile(req.params.id as string));
  })
);

router.get(
  '/:id/reviews',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await listSellerReviews(req.params.id as string, parseOr422(reviewListQuerySchema, req.query));
    sendSuccess(res, 200, 'Seller reviews fetched', result);
  })
);

export default router;
