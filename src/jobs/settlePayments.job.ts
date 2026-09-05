import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { captureDepositHold } from '../modules/payments/payments.service';

// Mirrors closeLots.job.ts's settlement transaction: SET LOCAL lock_timeout +
// FOR UPDATE as the first statement, bounding the wait for a lot row lock held
// by an in-flight bid/close/rollover instead of hanging the tick.
const LOCK_TIMEOUT_MS = 3000;
const TRANSACTION_TIMEOUT_MS = 8000;

export async function sweepOverduePayments() {
  const overduePayments = await prisma.payment.findMany({
    where: { status: 'PENDING', dueAt: { lte: new Date() } },
    select: { id: true },
  });

  for (const { id: paymentId } of overduePayments) {
    // Per-payment isolation: one payment's failure (lock contention, a Stripe
    // error) must not abort the rest of the batch.
    try {
      await settleOverduePayment(paymentId);
    } catch (err) {
      console.error(`sweepOverduePayments: failed to settle payment ${paymentId}:`, err);
    }
  }
}

async function settleOverduePayment(paymentId: string) {
  // Claim the payment atomically before doing anything else — including
  // before the Stripe capture below. Overlapping ticks (or a tick racing a
  // buyer who pays in the nick of time) must forfeit+rollover this payment at
  // most once. Re-checking dueAt guards against a stale row picked up by the
  // findMany above whose deadline no longer applies (shouldn't happen since
  // dueAt never moves, but keeps the claim self-contained).
  const claimed = await prisma.payment.updateMany({
    where: { id: paymentId, status: 'PENDING', dueAt: { lte: new Date() } },
    data: { status: 'FAILED' },
  });
  if (claimed.count === 0) return; // already handled by another tick, or the buyer paid in time

  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

  try {
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: 'PAYMENT_DEADLINE_FORFEITED',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { buyerId: payment.buyerId, lotId: payment.lotId },
      },
    });

    // Forfeit the deposit as a penalty. This is the real Stripe money-movement
    // call, so — per the closeLots/payments.service pattern — it happens
    // outside any DB transaction, on top of a hold whose capture is claimed
    // via captureDepositHold's own atomic claim-then-verify (never a bare DB
    // status flip trusted as proof the Stripe call actually completed).
    const hold = await prisma.depositHold.findFirst({
      where: { lotId: payment.lotId, buyerId: payment.buyerId, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
    });
    if (hold) {
      await captureDepositHold(hold);
    }

    await rolloverLot(payment.lotId, payment.buyerId);
  } catch (err) {
    // Nothing committed by the steps above depends on the Payment claim
    // sticking: the forfeiture audit log and hold capture are themselves
    // idempotent-safe to redo, and rolloverLot's DB write is one atomic
    // transaction (never a half-finished rollover to duplicate on retry).
    // So on any failure here, hand the claim back — same shape as
    // releasePendingHolds reverting a DepositHold claim in closeLots.job.ts —
    // so the next tick's findMany() picks this payment up again instead of
    // it being silently stuck FAILED with no rollover forever.
    await prisma.payment.updateMany({ where: { id: paymentId, status: 'FAILED' }, data: { status: 'PENDING' } });
    throw err;
  }
}

type LockedLot = { id: string };

// DB-only, same reasoning as closeLots.job.ts's settleLot: no Stripe calls in
// here, so a rollback never has to unwind an already-sent Stripe call.
async function rolloverLot(lotId: string, forfeitedBuyerId: string) {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

      const rows = await tx.$queryRaw<LockedLot[]>`SELECT id FROM "Lot" WHERE id = ${lotId} FOR UPDATE`;
      if (!rows[0]) return null;

      // The forfeited buyer's bid is no longer winning anything — demote it,
      // same as placeBid demotes the previous WINNING bid on a new bid. Keeps
      // "at most one WINNING bid per lot" true instead of leaving two.
      await tx.bid.updateMany({
        where: { lotId, buyerId: forfeitedBuyerId, status: 'WINNING' },
        data: { status: 'OUTBID' },
      });

      const nextBid = await tx.bid.findFirst({
        where: { lotId, buyerId: { not: forfeitedBuyerId }, status: 'OUTBID' },
        orderBy: { amountCents: 'desc' },
      });

      if (!nextBid) {
        await tx.lot.update({ where: { id: lotId }, data: { status: 'UNSOLD' } });
        await tx.auditLog.create({
          data: { actorId: null, action: 'LOT_ROLLED_OVER', entityType: 'Lot', entityId: lotId, metadata: { reason: 'no further bidders' } },
        });
        return null;
      }

      await tx.bid.update({ where: { id: nextBid.id }, data: { status: 'WINNING' } });
      await tx.lot.update({
        where: { id: lotId },
        data: { currentHighestBidAmountCents: nextBid.amountCents, currentHighestBidderId: nextBid.buyerId, status: 'SOLD' },
      });

      const nextHold = await tx.depositHold.findFirst({
        where: { lotId, buyerId: nextBid.buyerId, status: 'AUTHORIZED' },
      });
      const remainingCents = nextHold ? nextBid.amountCents - nextHold.amountCents : nextBid.amountCents;

      await tx.payment.create({
        data: {
          lotId,
          buyerId: nextBid.buyerId,
          amountCents: remainingCents,
          status: 'PENDING',
          dueAt: new Date(Date.now() + env.paymentDeadlineHours * 60 * 60 * 1000),
        },
      });
      await tx.auditLog.create({
        data: { actorId: null, action: 'LOT_ROLLED_OVER', entityType: 'Lot', entityId: lotId, metadata: { newWinnerId: nextBid.buyerId, amountCents: nextBid.amountCents } },
      });

      return { amountCents: nextBid.amountCents };
    },
    { isolationLevel: 'ReadCommitted', timeout: TRANSACTION_TIMEOUT_MS }
  );

  // Read-through cache (Task 10) kept consistent with the rolled-back amount,
  // done after commit so a value that never actually committed is never
  // cached. The DB transaction above is the source of truth and has already
  // committed by this point — a cache-write failure here must not propagate
  // up and cause settleOverduePayment's catch to revert+retry the whole
  // forfeiture (that would re-run rolloverLot and create a second rollover
  // Payment for the same lot). Best-effort only, same as any other
  // post-commit side effect in this codebase.
  if (result) {
    try {
      await redis.set(`lot:${lotId}:highestBid`, result.amountCents);
    } catch (err) {
      console.error(`rolloverLot: failed to update highestBid cache for lot ${lotId}:`, err);
    }
  }
}
