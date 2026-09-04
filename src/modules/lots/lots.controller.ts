import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { browseLotsSchema } from './lots.query';
import { browseLots, createLot, getLotDetail, listMyLots, publishLot, softDeleteLot, updateDraftLot } from './lots.service';

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
  const query = browseLotsSchema.parse(req.query);
  const result = await browseLots(query);
  sendSuccess(res, 200, 'Lots fetched', result);
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  const lot = await getLotDetail(req.params.id as string, req.user?.id);
  sendSuccess(res, 200, 'Lot fetched', lot);
});
