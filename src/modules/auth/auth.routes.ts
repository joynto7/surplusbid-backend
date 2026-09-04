import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema, refreshSchema } from './auth.validation';
import { register, login, refreshToken, logout } from './auth.controller';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/refresh-token', validate(refreshSchema), refreshToken);
router.post('/logout', logout);

export default router;
