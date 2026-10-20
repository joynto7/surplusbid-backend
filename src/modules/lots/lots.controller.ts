import { Request, Response } from 'express';
import { callerKey } from '../../middleware/keyRateLimit';
import { asyncHandler } from '../../utils/asyncHandler';
import { parseOr422 } from '../../utils/parseOr422';
import { sendSuccess } from '../../utils/response';
import { browseLotsSchema, recordViewSchema, relatedLotsSchema } from './lots.query';
import {
  browseLots,
  createLot,
  getLotDetail,
  getRelatedLots,
  listMyLots,
  publishLot,
  recordLotView,
  softDeleteLot,
  updateDraftLot,
} from './lots.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const files = (req.files as (Express.Multer.File & { path: string })[] | undefined) ?? [];
  const images = files.map((f) => f.path);
  const lot = await createLot(req.user!.id, req.body, images);
  sendSuccess(res, 201, 'Lot created as draft', lot);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const lot = await updateDraftLot(req.params.id as string, req.user!.id, req.body);
  sendSuccess(res, 200, 'Lot updated', lot);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await softDeleteLot(req.params.id as string, req.user!.id);
  sendSuccess(res, 200, 'Lot deleted', {});
});

export const publish = asyncHandler(async (req: Request, res: Response) => {
  const lot = await publishLot(req.params.id as string, req.user!.id);
  sendSuccess(res, 200, 'Lot is now live', lot);
});

export const myListings = asyncHandler(async (req: Request, res: Response) => {
  const lots = await listMyLots(req.user!.id);
  sendSuccess(res, 200, 'Your listings', lots);
});

export const browse = asyncHandler(async (req: Request, res: Response) => {
  const query = parseOr422(browseLotsSchema, req.query);
  const result = await browseLots(query, req.user?.role);
  sendSuccess(res, 200, 'Lots fetched', result);
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  const lot = await getLotDetail(req.params.id as string, req.user?.id);
  sendSuccess(res, 200, 'Lot fetched', lot);
});

export const related = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = parseOr422(relatedLotsSchema, req.query);
  const lots = await getRelatedLots(req.params.id as string, limit);
  sendSuccess(res, 200, 'Related lots fetched', lots);
});

export const view = asyncHandler(async (req: Request, res: Response) => {
  const { viewerId } = parseOr422(recordViewSchema, req.body ?? {});
  const result = await recordLotView(req.params.id as string, {
    ...(req.user?.id ? { userId: req.user.id } : {}),
    ...(viewerId ? { viewerId } : {}),
    fallback: callerKey(req),
  });
  sendSuccess(res, 200, result.counted ? 'View recorded' : 'View already counted', result);
});
