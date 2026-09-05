import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { getById, initiate, myPayments, webhook } from './payments.controller';

const router = Router();

router.post('/initiate', authenticate, requireRole('BUYER'), initiate);
router.post('/webhook', webhook);
router.get('/my-payments', authenticate, requireRole('BUYER'), myPayments);
router.get('/:id', authenticate, requireRole('BUYER'), getById);

export default router;
