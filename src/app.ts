import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import categoriesRoutes from './modules/categories/categories.routes';
import lotsRoutes from './modules/lots/lots.routes';
import bidsRoutes, { myBidsRouter } from './modules/bids/bids.routes';
import paymentsRoutes from './modules/payments/payments.routes';
import passport from './config/passport';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
// Stripe webhook signature verification needs the raw request body, so this
// must be mounted (and match) BEFORE the global express.json() below —
// otherwise json() consumes the stream and the signature check silently fails.
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(
  rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false })
);
app.use(passport.initialize());

app.get('/api/v1/health', (_req, res) => {
  res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/categories', categoriesRoutes);
app.use('/api/v1/lots', bidsRoutes);
app.use('/api/v1/lots', lotsRoutes);
app.use('/api/v1/bids', myBidsRouter);
app.use('/api/v1/payments', paymentsRoutes);

app.use(errorHandler);

export default app;
