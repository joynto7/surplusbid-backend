import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { upload } from '../../middleware/upload';
import { updateProfileSchema } from './users.validation';
import { me, updateProfile, verify } from './users.controller';

const router = Router();

router.get('/me', authenticate, me);
router.patch('/me', authenticate, validate(updateProfileSchema), updateProfile);
router.post('/verify', authenticate, upload.single('document'), verify);

export default router;
