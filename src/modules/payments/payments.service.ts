import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';

// DB "CAPTURED" only means someone claimed the hold, not that Stripe actually
// collected it (the capture() call after the claim may have thrown). Stripe's
// own PaymentIntent status is the real source of truth: 'requires_capture'
// means the money was never taken, so capture it now; anything else (already
// 'succeeded', etc.) means a prior attempt already finished — don't re-capture,
// Stripe rejects a second capture on an already-captured intent.
export async function ensureDepositCaptured(stripePaymentIntentId: string) {
  const intent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
  if (intent.status === 'requires_capture') {
    await stripe.paymentIntents.capture(stripePaymentIntentId);
  }
}

// Shared by initiatePayment (normal balance-payment flow) and the payment-
// deadline sweep (forfeiture flow, settlePayments.job.ts) — both need to turn
// an AUTHORIZED deposit hold into a real Stripe capture exactly once. Claim
// the hold row before calling Stripe so two concurrent callers (a retried
// request, an overlapping cron tick) can't both call capture() on the same
// PaymentIntent; the loser of the claim race falls back to checking Stripe
// directly rather than assuming the winner's call actually completed.
export async function captureDepositHold(hold: { id: string; status: string; stripePaymentIntentId: string }) {
  if (hold.status === 'AUTHORIZED') {
    const claimed = await prisma.depositHold.updateMany({ where: { id: hold.id, status: 'AUTHORIZED' }, data: { status: 'CAPTURED' } });
    if (claimed.count > 0) {
      await stripe.paymentIntents.capture(hold.stripePaymentIntentId);
    } else {
      await ensureDepositCaptured(hold.stripePaymentIntentId);
    }
  } else if (hold.status === 'CAPTURED') {
    await ensureDepositCaptured(hold.stripePaymentIntentId);
  }
  // RELEASED/FAILED: nothing to capture — the hold was already let go.
}

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

  if (hold.status !== 'AUTHORIZED' && hold.status !== 'CAPTURED') {
    // RELEASED/FAILED: the deposit was never actually captured, so there's
    // nothing to build the balance charge on top of.
    throw new ApiError(409, 'This payment has already been processed');
  }
  // Claim-then-verify: see captureDepositHold's own comment for why a claim
  // race or a resumed CAPTURED row is never trusted blindly.
  await captureDepositHold(hold);

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
