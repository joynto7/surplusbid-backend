import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { stripe } from '../../config/stripe';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { getMyPayments, getPaymentById, handleWebhookEvent, initiatePayment, PaymentIntentWebhookEvent } from './payments.service';
import { paginationQuerySchema } from './payments.query';

export const initiate = asyncHandler(async (req: Request, res: Response) => {
  const payment = await initiatePayment(req.body.paymentId, req.user!.id);
  sendSuccess(res, 200, 'Payment initiated', payment);
});

export const webhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature as string, env.stripeWebhookSecret);
  } catch {
    throw new ApiError(400, 'Invalid webhook signature');
  }
  await handleWebhookEvent(event as unknown as PaymentIntentWebhookEvent);
  res.json({ received: true });
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const payment = await getPaymentById(req.params.id as string, req.user!.id);
  sendSuccess(res, 200, 'Payment fetched', payment);
});

export const myPayments = asyncHandler(async (req: Request, res: Response) => {
  const parsed = paginationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ApiError(422, 'Validation failed', errors);
  }
  const result = await getMyPayments(req.user!.id, parsed.data.page, parsed.data.limit);
  sendSuccess(res, 200, 'Your payments fetched', result);
});
