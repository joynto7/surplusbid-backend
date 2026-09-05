import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { bidRateLimit } from '../../middleware/bidRateLimit';
import { placeBidSchema } from './bids.validation';
import { bid, deposit, history, myBids } from './bids.controller';

const router = Router({ mergeParams: true });

router.post('/:id/deposit', authenticate, requireRole('BUYER'), deposit);
router.post('/:id/bids', authenticate, requireRole('BUYER'), bidRateLimit, validate(placeBidSchema), bid);
router.get('/:id/bids', history);

export const myBidsRouter = Router();
myBidsRouter.get('/my-bids', authenticate, requireRole('BUYER'), myBids);

export default router;
