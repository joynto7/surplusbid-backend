import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

type Role = 'BUYER' | 'SELLER' | 'ADMIN';

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have access to this resource'));
    }
    next();
  };
}
