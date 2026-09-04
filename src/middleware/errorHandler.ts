import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/ApiError';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ success: false, message: err.message, errors: err.errors });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'A record with this value already exists',
        errors: [String(err.meta?.target ?? 'unique constraint')],
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Record not found', errors: [] });
    }
    // Contention, not a bug: the request queued too long for a pooled connection
    // (P2024), the interactive transaction ran out of budget (P2028), or a row-lock
    // wait hit `SET LOCAL lock_timeout` (P2010 wrapping Postgres 55P03, as placeBid
    // sets). All three clear on their own, so say "retry" instead of "we broke".
    const pgCode = (err.meta as { code?: string } | undefined)?.code;
    if (err.code === 'P2024' || err.code === 'P2028' || pgCode === '55P03') {
      return res.status(503).json({ success: false, message: 'The server is busy, please try again', errors: [] });
    }
  }

  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ success: false, message: 'Something went wrong', errors: [] });
}
