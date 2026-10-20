import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { latestReviews } from './reviews.service';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { create, mine, received, reviewable } from './reviews.controller';
import { createReviewSchema } from './reviews.validation';

const router = Router();

router.get(
  '/latest',
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = parseOr422(z.object({ limit: z.coerce.number().int().positive().max(12).default(6) }), req.query);
    sendSuccess(res, 200, 'Latest reviews fetched', await latestReviews(limit));
  })
);
router.post('/', authenticate, requireRole('BUYER'), validate(createReviewSchema), create);
router.get('/mine', authenticate, requireRole('BUYER'), mine);
router.get('/reviewable', authenticate, requireRole('BUYER'), reviewable);
router.get('/received', authenticate, requireRole('SELLER'), received);

export default router;
