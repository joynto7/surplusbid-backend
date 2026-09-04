import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createCategorySchema } from './categories.validation';
import { create, list } from './categories.controller';

const router = Router();

router.get('/', list);
router.post('/', authenticate, requireRole('ADMIN'), validate(createCategorySchema), create);

export default router;
