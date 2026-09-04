import { NextFunction, Request, Response, Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { upload } from '../../middleware/upload';
import { verifyAccessToken } from '../../utils/jwt';
import { createLotSchema, updateLotSchema } from './lots.validation';
import { browse, create, detail, myListings, publish, remove, update } from './lots.controller';

const router = Router();

router.post('/', authenticate, requireRole('SELLER'), upload.array('images', 5), validate(createLotSchema), create);
router.get('/my-listings', authenticate, requireRole('SELLER'), myListings);
router.patch('/:id', authenticate, requireRole('SELLER'), validate(updateLotSchema), update);
router.delete('/:id', authenticate, requireRole('SELLER'), remove);
router.patch('/:id/publish', authenticate, requireRole('SELLER'), publish);

function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try { req.user = verifyAccessToken(header.slice(7)); } catch { /* ignore invalid token, stay anonymous */ }
  }
  next();
}

router.get('/', browse);
router.get('/:id', optionalAuth, detail);

export default router;
