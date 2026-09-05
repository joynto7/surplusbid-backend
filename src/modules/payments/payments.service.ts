import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';

export async function initiatePayment(paymentId: string, buyerId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, buyerId } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status !== 'PENDING') throw new ApiError(409, 'This payment has already been processed');

  const hold = await prisma.depositHold.findFirstOrThrow({ where: { lotId: payment.lotId, buyerId, status: 'AUTHORIZED' } });
  await stripe.paymentIntents.capture(hold.stripePaymentIntentId);
  // ponytail: a crash between the capture above and the two writes below leaves
  // the charge captured at Stripe but the hold still AUTHORIZED and the payment's
  // stripePaymentIntentId unset — the payment_intent.succeeded webhook then finds
  // no matching Payment row (updateMany matches on stripePaymentIntentId) and is a
  // silent no-op, so the payment is stuck PENDING with money already taken. Add a
  // reconciliation sweep (list captured PaymentIntents against PENDING payments)
  // if this needs to be self-healing; today it needs manual intervention.
  await prisma.depositHold.update({ where: { id: hold.id }, data: { status: 'CAPTURED' } });

  return prisma.payment.update({
    where: { id: paymentId },
    data: { stripePaymentIntentId: hold.stripePaymentIntentId },
  });
}

export async function handleWebhookEvent(event: { type: string; data: { object: { id: string } } }) {
  if (event.type === 'payment_intent.succeeded') {
    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: event.data.object.id },
      data: { status: 'SUCCEEDED', paidAt: new Date() },
    });
  }
  if (event.type === 'payment_intent.payment_failed') {
    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: event.data.object.id },
      data: { status: 'FAILED' },
    });
  }
}

export async function getPaymentById(paymentId: string, requesterId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, buyerId: requesterId } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  return payment;
}

export async function getMyPayments(buyerId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where: { buyerId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.payment.count({ where: { buyerId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
