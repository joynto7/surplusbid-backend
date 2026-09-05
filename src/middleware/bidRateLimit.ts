import { NextFunction, Request, Response } from 'express';
import { redis } from '../config/redis';
import { ApiError } from '../utils/ApiError';

const WINDOW_SECONDS = 60;
const MAX_BIDS_PER_WINDOW = 5;

export async function bidRateLimit(req: Request, _res: Response, next: NextFunction) {
  const key = `bid-rate:${req.user!.id}:${req.params.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  if (count > MAX_BIDS_PER_WINDOW) {
    return next(new ApiError(429, 'Too many bids on this lot — slow down and try again shortly'));
  }
  next();
}
