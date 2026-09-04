import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { findLotById } from '../lots/lots.service';

export async function getActiveHold(lotId: string, buyerId: string) {
  return prisma.depositHold.findFirst({ where: { lotId, buyerId, status: 'AUTHORIZED' } });
}

export async function createDepositHold(lotId: string, buyerId: string) {
  const lot = await findLotById(lotId);
  if (lot.status !== 'LIVE') throw new ApiError(409, 'This lot is not open for bidding');

  const existing = await prisma.depositHold.findUnique({ where: { lotId_buyerId: { lotId, buyerId } } });
  if (existing) throw new ApiError(409, 'A deposit hold already exists for this lot');

  const amountCents = Math.round(lot.startingPriceCents * (env.depositPercent / 100));
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    capture_method: 'manual',
    metadata: { lotId, buyerId },
  });

  return prisma.depositHold.create({
    data: { lotId, buyerId, amountCents, stripePaymentIntentId: intent.id, status: 'AUTHORIZED' },
  });
}
