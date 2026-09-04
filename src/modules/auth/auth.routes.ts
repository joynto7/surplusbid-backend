import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema, refreshSchema } from './auth.validation';
import { register, login, refreshToken, logout } from './auth.controller';
import passport from '../../config/passport';
import { googleCallback } from './googleAuth.controller';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/refresh-token', validate(refreshSchema), refreshToken);
router.post('/logout', logout);

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/google/callback', passport.authenticate('google', { session: false }), googleCallback);

export default router;
