import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { initiatePaymentSchema } from './payments.validation';
import { getById, initiate, myPayments, webhook } from './payments.controller';

const router = Router();

router.post('/initiate', authenticate, requireRole('BUYER'), validate(initiatePaymentSchema), initiate);
router.post('/webhook', webhook);
router.get('/my-payments', authenticate, requireRole('BUYER'), myPayments);
router.get('/:id', authenticate, requireRole('BUYER'), getById);

export default router;
