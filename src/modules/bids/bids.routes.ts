import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { placeBidSchema } from './bids.validation';
import { bid, deposit } from './bids.controller';

const router = Router({ mergeParams: true });

router.post('/:id/deposit', authenticate, requireRole('BUYER'), deposit);
router.post('/:id/bids', authenticate, requireRole('BUYER'), validate(placeBidSchema), bid);

export default router;
