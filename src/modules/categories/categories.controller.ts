import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createCategory, listCategories } from './categories.service';

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await listCategories();
  sendSuccess(res, 200, 'Categories fetched', categories);
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const category = await createCategory(req.body.name);
  sendSuccess(res, 201, 'Category created', category);
});
