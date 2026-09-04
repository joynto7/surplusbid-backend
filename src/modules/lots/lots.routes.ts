import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { upload } from '../../middleware/upload';
import { createLotSchema, updateLotSchema } from './lots.validation';
import { create, myListings, publish, remove, update } from './lots.controller';

const router = Router();

router.post('/', authenticate, requireRole('SELLER'), upload.array('images', 5), validate(createLotSchema), create);
router.get('/my-listings', authenticate, requireRole('SELLER'), myListings);
router.patch('/:id', authenticate, requireRole('SELLER'), validate(updateLotSchema), update);
router.delete('/:id', authenticate, requireRole('SELLER'), remove);
router.patch('/:id/publish', authenticate, requireRole('SELLER'), publish);

export default router;
