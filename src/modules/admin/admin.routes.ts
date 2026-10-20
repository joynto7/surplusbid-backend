import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { insights } from '../ai/ai.controller';
import { messageStatusSchema, verifyUserSchema } from './admin.validation';
import {
  analytics,
  auditLogs,
  dashboardStats,
  messageStatus,
  messages,
  removeReview,
  reviews,
  users,
  verify,
} from './admin.controller';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

router.get('/users', users);
router.patch('/users/:id/verify', validate(verifyUserSchema), verify);
router.get('/dashboard-stats', dashboardStats);
router.get('/analytics', analytics);
router.get('/ai-insights', insights);
router.get('/audit-logs', auditLogs);
router.get('/messages', messages);
router.patch('/messages/:id', validate(messageStatusSchema), messageStatus);
router.get('/reviews', reviews);
router.delete('/reviews/:id', removeReview);

export default router;
