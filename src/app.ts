import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './modules/auth/auth.routes';
import passport from './config/passport';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
app.use(
  rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false })
);
app.use(passport.initialize());

app.get('/api/v1/health', (_req, res) => {
  res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
});

app.use('/api/v1/auth', authRoutes);

app.use(errorHandler);

export default app;
