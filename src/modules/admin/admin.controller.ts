import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { deleteReview, listAllReviews } from '../reviews/reviews.service';
import { reviewListQuerySchema } from '../reviews/reviews.validation';
import { getAnalytics } from './admin.analytics';
import {
  getDashboardStats,
  listAuditLogs,
  listMessages,
  listUsers,
  updateMessageStatus,
  verifyUser,
} from './admin.service';
import { messagesQuerySchema, usersQuerySchema } from './admin.validation';

export const users = asyncHandler(async (req: Request, res: Response) => {
  const q = parseOr422(usersQuerySchema, req.query);
  const result = await listUsers(q.page, q.limit, q.verificationStatus, q.role, q.q);
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

export const analytics = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, 200, 'Analytics fetched', await getAnalytics());
});

export const auditLogs = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await listAuditLogs(page, limit, req.query.entityType as string);
  sendSuccess(res, 200, 'Audit logs fetched', result);
});

export const messages = asyncHandler(async (req: Request, res: Response) => {
  const q = parseOr422(messagesQuerySchema, req.query);
  sendSuccess(res, 200, 'Messages fetched', await listMessages(q.page, q.limit, q.status, q.q));
});

export const messageStatus = asyncHandler(async (req: Request, res: Response) => {
  const message = await updateMessageStatus(req.params.id as string, req.body.status);
  sendSuccess(res, 200, 'Message updated', message);
});

export const reviews = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, 200, 'Reviews fetched', await listAllReviews(parseOr422(reviewListQuerySchema, req.query)));
});

export const removeReview = asyncHandler(async (req: Request, res: Response) => {
  await deleteReview(req.params.id as string, req.user!.id);
  sendSuccess(res, 200, 'Review removed', {});
});
