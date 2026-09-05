import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';

export async function initiatePayment(paymentId: string, buyerId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, buyerId } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status !== 'PENDING') throw new ApiError(409, 'This payment has already been processed');

  // Payment.stripePaymentIntentId is the source of truth for "did a previous
  // attempt already get as far as creating the balance PaymentIntent". If so,
  // never create another one — just hand back the same client_secret. Covers
  // both a naive double-call after success and a lost-response replay.
  if (payment.stripePaymentIntentId) {
    const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
    return { ...payment, clientSecret: existing.client_secret };
  }

  // No status filter here: a retry after a partial failure may find the hold
  // already CAPTURED (Stripe capture succeeded, but something after it — the
  // PaymentIntent create or the Payment write — didn't), and that must resume
  // rather than 404.
  const hold = await prisma.depositHold.findFirstOrThrow({ where: { lotId: payment.lotId, buyerId } });

  if (hold.status === 'AUTHORIZED') {
    // Claim the hold before talking to Stripe: a concurrent or retried /initiate
    // call must not attempt to capture the same PaymentIntent twice (Stripe
    // rejects a second capture on an already-captured intent). Mirrors
    // releasePendingHolds in closeLots.job.ts. If we lose the claim race, another
    // in-flight request already captured it — fall through to creating (or, via
    // the idempotency key below, de-duping) the balance PaymentIntent.
    const claimed = await prisma.depositHold.updateMany({ where: { id: hold.id, status: 'AUTHORIZED' }, data: { status: 'CAPTURED' } });
    if (claimed.count > 0) {
      // This only finalizes the deposit (a small percentage of the lot price,
      // already authorized back in Task 11) — it can never collect more than
      // that intent's original amount.
      await stripe.paymentIntents.capture(hold.stripePaymentIntentId);
    }
  } else if (hold.status !== 'CAPTURED') {
    // RELEASED/FAILED: the deposit was never actually captured, so there's
    // nothing to build the balance charge on top of.
    throw new ApiError(409, 'This payment has already been processed');
  }

  // The remaining balance (winning bid minus deposit, computed by the settlement
  // job in closeLots.job.ts) is a separate charge with no saved payment method to
  // charge off-session, so it needs its own PaymentIntent for the buyer to confirm.
  // Idempotency key keyed on paymentId: if a retry somehow reaches this line twice
  // (e.g. the DB write below failed last time), Stripe de-dupes instead of
  // minting a second PaymentIntent for the same balance.
  const intent = await stripe.paymentIntents.create(
    {
      amount: payment.amountCents,
      currency: 'usd',
      metadata: { paymentId: payment.id, lotId: payment.lotId, buyerId },
    },
    { idempotencyKey: paymentId }
  );

  // Recorded immediately — its id is known as soon as create() resolves, well
  // before the buyer confirms/pays — so the payment_intent.succeeded webhook
  // always has a Payment row to match against.
  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { stripePaymentIntentId: intent.id },
  });

  return { ...updated, clientSecret: intent.client_secret };
}

export type PaymentIntentWebhookEvent = {
  type: string;
  data: { object: { id: string; amount: number; currency: string } };
};

export async function handleWebhookEvent(event: PaymentIntentWebhookEvent) {
  if (event.type !== 'payment_intent.succeeded' && event.type !== 'payment_intent.payment_failed') return;

  const stripePaymentIntentId = event.data.object.id;
  const payment = await prisma.payment.findFirst({ where: { stripePaymentIntentId } });
  // No matching row, or already settled (Stripe redelivers events) — nothing to do.
  if (!payment || payment.status !== 'PENDING') return;

  if (event.type === 'payment_intent.succeeded') {
    if (event.data.object.amount !== payment.amountCents || event.data.object.currency !== 'usd') {
      console.error(
        `handleWebhookEvent: amount/currency mismatch for payment ${payment.id} (intent ${stripePaymentIntentId}): expected ${payment.amountCents} usd, got ${event.data.object.amount} ${event.data.object.currency}`
      );
      return;
    }
    await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date() } });
  } else {
    await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED' } });
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
