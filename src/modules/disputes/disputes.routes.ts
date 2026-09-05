import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createDisputeSchema, resolveDisputeSchema } from './disputes.validation';
import { create, resolve } from './disputes.controller';

const router = Router();

router.post('/', authenticate, requireRole('BUYER', 'SELLER'), validate(createDisputeSchema), create);
router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), validate(resolveDisputeSchema), resolve);

export default router;
