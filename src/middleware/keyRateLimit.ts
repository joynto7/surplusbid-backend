import { NextFunction, Request, Response } from 'express';
import { redis } from '../config/redis';
import { ApiError } from '../utils/ApiError';

/**
 * Who is calling, for per-caller limits. Signed-in users are keyed by id.
 * Anonymous browser traffic arrives through the frontend's BFF, which forwards
 * the visitor's address as X-Client-IP; direct callers fall back to req.ip.
 */
export function callerKey(req: Request) {
  if (req.user?.id) return `u:${req.user.id}`;
  const forwarded = req.headers['x-client-ip'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip || 'unknown';
  return `ip:${ip}`;
}

/** Fixed-window limiter in Redis, same shape as bidRateLimit but for any route. */
export function keyRateLimit(name: string, max: number, windowSeconds: number, message: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const key = `rl:${name}:${callerKey(req)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      if (count > max) return next(new ApiError(429, message));
      next();
    } catch (err) {
      next(err);
    }
  };
}
