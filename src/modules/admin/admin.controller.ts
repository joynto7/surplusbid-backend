import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { getDashboardStats, listAuditLogs, listUsers, verifyUser } from './admin.service';

export const users = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await listUsers(page, limit, req.query.verificationStatus as string, req.query.role as string);
  sendSuccess(res, 200, 'Users fetched', result);
});

export const verify = asyncHandler(async (req: Request, res: Response) => {
  const user = await verifyUser(req.params.id as string, req.user!.id, req.body.verificationStatus);
  sendSuccess(res, 200, 'User verification updated', user);
});

export const dashboardStats = asyncHandler(async (_req: Request, res: Response) => {
  const stats = await getDashboardStats();
  sendSuccess(res, 200, 'Dashboard stats fetched', stats);
});

export const auditLogs = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await listAuditLogs(page, limit, req.query.entityType as string);
  sendSuccess(res, 200, 'Audit logs fetched', result);
});
