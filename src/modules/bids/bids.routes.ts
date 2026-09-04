import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { deposit } from './bids.controller';

const router = Router({ mergeParams: true });

router.post('/:id/deposit', authenticate, requireRole('BUYER'), deposit);

export default router;
