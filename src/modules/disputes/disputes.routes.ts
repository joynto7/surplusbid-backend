import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createDisputeSchema, resolveDisputeSchema } from './disputes.validation';
import { create, list, mine, resolve } from './disputes.controller';

const router = Router();

router.post('/', authenticate, requireRole('BUYER', 'SELLER'), validate(createDisputeSchema), create);
router.get('/mine', authenticate, requireRole('BUYER', 'SELLER'), mine);
router.get('/', authenticate, requireRole('ADMIN'), list);
router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), validate(resolveDisputeSchema), resolve);

export default router;
