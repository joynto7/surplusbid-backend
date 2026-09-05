import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { verifyUserSchema } from './admin.validation';
import { auditLogs, dashboardStats, users, verify } from './admin.controller';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

router.get('/users', users);
router.patch('/users/:id/verify', validate(verifyUserSchema), verify);
router.get('/dashboard-stats', dashboardStats);
router.get('/audit-logs', auditLogs);

export default router;
