import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { keyRateLimit } from '../../middleware/keyRateLimit';
import { optionalAuth } from '../../middleware/optionalAuth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { upload } from '../../middleware/upload';
import { createLotSchema, updateLotSchema } from './lots.validation';
import { browse, create, detail, myListings, publish, related, remove, update, view } from './lots.controller';

const router = Router();

router.post('/', authenticate, requireRole('SELLER'), upload.array('images', 5), validate(createLotSchema), create);
router.get('/my-listings', authenticate, requireRole('SELLER'), myListings);
router.patch('/:id', authenticate, requireRole('SELLER'), validate(updateLotSchema), update);
router.delete('/:id', authenticate, requireRole('SELLER'), remove);
router.patch('/:id/publish', authenticate, requireRole('SELLER'), publish);

router.get('/', optionalAuth, browse);
router.get('/:id', optionalAuth, detail);
router.get('/:id/related', related);
router.post(
  '/:id/view',
  optionalAuth,
  keyRateLimit('lot-view', 120, 60, 'Too many requests, slow down'),
  view
);

export default router;
