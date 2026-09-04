import cron from 'node-cron';
import { prisma } from '../config/prisma';
import { stripe } from '../config/stripe';
import { env } from '../config/env';

type LockedLot = {
  id: string;
  status: string;
  endTime: Date;
  currentHighestBidAmountCents: number | null;
  currentHighestBidderId: string | null;
};

// Mirrors placeBid (see bids.service.ts): bound the FOR UPDATE wait so a lot whose
// row lock is held by an in-flight bid fails fast with Postgres 55P03 instead of
// hanging the tick. Prisma's client-side transaction timeout does NOT cancel a
// blocked lock wait in Postgres, so without this the wait is unbounded.
const LOCK_TIMEOUT_MS = 3000;
const TRANSACTION_TIMEOUT_MS = 8000;

export async function closeLots() {
  const endedLots = await prisma.lot.findMany({
    where: { status: 'LIVE', endTime: { lte: new Date() } },
    select: { id: true },
  });

  for (const { id: lotId } of endedLots) {
    // Per-lot isolation: a lock timeout (or anything else) on one contended lot
    // must not skip the other, uncontended lots in this batch.
    try {
      await settleLot(lotId);
    } catch (err) {
      console.error(`closeLots: failed to settle lot ${lotId}:`, err);
    }
  }

  await releasePendingHolds();
}

// DB-only. No Stripe calls inside the transaction: a Stripe round-trip per hold
// blows Prisma's transaction budget on a lot with many bidders, and a rollback
// after some cancels have already been sent is unrecoverable (Stripe does not
// roll back, and re-cancelling throws) — which used to wedge the lot as
// permanently unsettleable. Stripe cancels happen after this commits, driven by
// the committed DB state.
async function settleLot(lotId: string) {
  await prisma.$transaction(
    async (tx) => {
      // Takes no locks and reads nothing, so the locked read below is still the
      // first statement to touch contended state. $executeRawUnsafe because SET
      // does not accept bind parameters; the value is a module constant.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

      // Lock the Lot row first, same as placeBid — a bid that is mid-flight holds
      // this same row lock until it commits, and can extend endTime via
      // anti-sniping. Re-reading under the lock (rather than trusting the
      // unlocked snapshot from the findMany above) guarantees we never close a
      // lot that a concurrent bid just legitimately extended, and makes
      // overlapping ticks settle a lot exactly once.
      const rows = await tx.$queryRaw<LockedLot[]>`
        SELECT id, status, "endTime", "currentHighestBidAmountCents", "currentHighestBidderId"
        FROM "Lot" WHERE id = ${lotId} FOR UPDATE
      `;
      const lot = rows[0];
      if (!lot || lot.status !== 'LIVE' || lot.endTime.getTime() > Date.now()) return;

      if (!lot.currentHighestBidderId) {
        await tx.lot.update({ where: { id: lot.id }, data: { status: 'UNSOLD' } });
        await tx.auditLog.create({
          data: { actorId: null, action: 'LOT_UNSOLD', entityType: 'Lot', entityId: lot.id, metadata: { reason: 'no bids' } },
        });
        return;
      }

      const winnerHold = await tx.depositHold.findFirst({
        where: { lotId: lot.id, buyerId: lot.currentHighestBidderId, status: 'AUTHORIZED' },
      });
      const winningAmount = lot.currentHighestBidAmountCents ?? 0;
      const remainingCents = winnerHold ? winningAmount - winnerHold.amountCents : winningAmount;

      await tx.lot.update({ where: { id: lot.id }, data: { status: 'SOLD' } });
      await tx.payment.create({
        data: {
          lotId: lot.id,
          buyerId: lot.currentHighestBidderId,
          amountCents: remainingCents,
          status: 'PENDING',
          dueAt: new Date(Date.now() + env.paymentDeadlineHours * 60 * 60 * 1000),
        },
      });
      await tx.auditLog.create({
        data: { actorId: null, action: 'LOT_SOLD', entityType: 'Lot', entityId: lot.id, metadata: { winnerId: lot.currentHighestBidderId, amountCents: winningAmount } },
      });
    },
    { isolationLevel: 'ReadCommitted', timeout: TRANSACTION_TIMEOUT_MS }
  );
}

// An AUTHORIZED hold on an already-settled lot that isn't the winner's IS the
// "needs a Stripe cancel" state — no extra column needed, and it is re-derived
// from committed data, so a hold whose cancel failed (or a tick that died between
// commit and cancel) is picked up cleanly on the next tick.
async function releasePendingHolds() {
  const pending = await prisma.depositHold.findMany({
    where: { status: 'AUTHORIZED', lot: { status: { in: ['SOLD', 'UNSOLD'] } } },
    select: {
      id: true,
      buyerId: true,
      stripePaymentIntentId: true,
      lot: { select: { currentHighestBidderId: true } },
    },
  });

  for (const hold of pending) {
    if (hold.buyerId === hold.lot.currentHighestBidderId) continue; // winner keeps their hold

    // Claim the hold before talking to Stripe: overlapping ticks race here and
    // exactly one wins, so a PaymentIntent is never cancelled twice.
    const claimed = await prisma.depositHold.updateMany({
      where: { id: hold.id, status: 'AUTHORIZED' },
      data: { status: 'RELEASED' },
    });
    if (claimed.count === 0) continue;

    try {
      await stripe.paymentIntents.cancel(hold.stripePaymentIntentId);
    } catch (err) {
      if (isAlreadyCancelled(err)) continue;
      // Hand the hold back so the next tick retries it.
      // ponytail: a crash between the claim above and this revert leaves the hold
      // RELEASED in the DB while still authorized at Stripe (it expires on its own
      // in ~7 days). Add a reconciliation sweep against Stripe if that matters.
      console.error(`closeLots: failed to cancel hold ${hold.id}:`, err);
      await prisma.depositHold.updateMany({ where: { id: hold.id }, data: { status: 'AUTHORIZED' } });
    }
  }
}

// Stripe rejects cancelling a PaymentIntent that is no longer cancellable with
// payment_intent_unexpected_state. For a hold we are releasing that means the
// work is already done (or can never succeed), so treat it as success — retrying
// it forever is what wedges the job.
function isAlreadyCancelled(err: unknown) {
  const code = (err as { code?: string; raw?: { code?: string } })?.code ?? (err as { raw?: { code?: string } })?.raw?.code;
  return code === 'payment_intent_unexpected_state';
}

export function startCronJobs() {
  cron.schedule('* * * * *', () => {
    closeLots().catch((err) => console.error('closeLots job failed:', err));
  });
}
