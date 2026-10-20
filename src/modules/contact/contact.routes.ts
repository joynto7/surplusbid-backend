import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { keyRateLimit } from '../../middleware/keyRateLimit';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';

export const contactSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  topic: z.enum(['buying', 'selling', 'verification', 'payments', 'other']),
  message: z.string().trim().min(20).max(2000),
});

export const newsletterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export const contactRouter = Router();

contactRouter.post(
  '/',
  keyRateLimit('contact', 5, 15 * 60, 'You have sent several messages already. Please wait a few minutes.'),
  validate(contactSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const message = await prisma.contactMessage.create({ data: req.body, select: { id: true, createdAt: true } });
    sendSuccess(res, 201, 'Message received. We reply within one business day.', message);
  })
);

export const newsletterRouter = Router();

newsletterRouter.post(
  '/',
  keyRateLimit('newsletter', 10, 15 * 60, 'Too many sign-up attempts. Please try again later.'),
  validate(newsletterSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body as z.infer<typeof newsletterSchema>;
    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
    if (existing) return sendSuccess(res, 200, "You're already subscribed. Thanks for staying with us!", { email });
    await prisma.newsletterSubscriber.create({ data: { email } });
    sendSuccess(res, 201, 'Subscribed. Look out for the weekly closing-soon digest.', { email });
  })
);
