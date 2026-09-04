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

export async function closeLots() {
  const endedLots = await prisma.lot.findMany({
    where: { status: 'LIVE', endTime: { lte: new Date() } },
    select: { id: true },
  });

  for (const { id: lotId } of endedLots) {
    await prisma.$transaction(async (tx) => {
      // Lock the Lot row first, same as placeBid (see bids.service.ts) — a bid that
      // is mid-flight holds this same row lock until it commits, and can extend
      // endTime via anti-sniping. Re-reading under the lock (rather than trusting
      // the unlocked snapshot from the findMany above) guarantees we never close a
      // lot that a concurrent bid just legitimately extended.
      const rows = await tx.$queryRaw<LockedLot[]>`
        SELECT id, status, "endTime", "currentHighestBidAmountCents", "currentHighestBidderId"
        FROM "Lot" WHERE id = ${lotId} FOR UPDATE
      `;
      const lot = rows[0];
      if (!lot || lot.status !== 'LIVE' || lot.endTime.getTime() > Date.now()) return;

      const holds = await tx.depositHold.findMany({ where: { lotId: lot.id, status: 'AUTHORIZED' } });

      if (!lot.currentHighestBidderId) {
        await tx.lot.update({ where: { id: lot.id }, data: { status: 'UNSOLD' } });
        for (const hold of holds) {
          await stripe.paymentIntents.cancel(hold.stripePaymentIntentId);
          await tx.depositHold.update({ where: { id: hold.id }, data: { status: 'RELEASED' } });
        }
        await tx.auditLog.create({
          data: { actorId: null, action: 'LOT_UNSOLD', entityType: 'Lot', entityId: lot.id, metadata: { reason: 'no bids' } },
        });
        return;
      }

      for (const hold of holds) {
        if (hold.buyerId === lot.currentHighestBidderId) continue;
        await stripe.paymentIntents.cancel(hold.stripePaymentIntentId);
        await tx.depositHold.update({ where: { id: hold.id }, data: { status: 'RELEASED' } });
      }

      const winnerHold = holds.find((h) => h.buyerId === lot.currentHighestBidderId);
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
    });
  }
}

export function startCronJobs() {
  cron.schedule('* * * * *', () => {
    closeLots().catch((err) => console.error('closeLots job failed:', err));
  });
}
