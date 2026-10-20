import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';

/** Attaches req.user when a valid bearer token is present; anonymous requests pass through untouched. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = verifyAccessToken(header.slice(7));
    } catch {
      /* ignore invalid token, stay anonymous */
    }
  }
  next();
}
