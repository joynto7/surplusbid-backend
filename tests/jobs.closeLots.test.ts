import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { stripe } from '../src/config/stripe';
import { closeLots } from '../src/jobs/closeLots.job';

// Own client, own connection pool: this is what makes the competing row lock in
// the lock-contention test real rather than mocked (same pattern as
// tests/bids.lockTimeout.test.ts).
const competitor = new PrismaClient();

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { cancel: jest.fn().mockResolvedValue({}) } },
}));

const cancelMock = stripe.paymentIntents.cancel as unknown as jest.Mock;
const cancelCallsFor = (paymentIntentId: string) =>
  cancelMock.mock.calls.filter(([pi]) => pi === paymentIntentId);

let sellerId: string, categoryId: string, lotId: string, winnerId: string, loserId: string;

// Lots created inside individual tests (so an earlier test's closeLots() run
// does not settle a later test's fixture), collected here for cleanup.
const extraLotIds: string[] = [];

async function createEndedLot(title: string, winner: string | null, amountCents: number | null) {
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title, description: 'For close-job testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() - 1000), status: 'LIVE',
      currentHighestBidAmountCents: amountCents, currentHighestBidderId: winner,
    },
  });
  extraLotIds.push(lot.id);
  return lot.id;
}

beforeAll(async () => {
  const [winner, loser, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'close-winner@test.com', role: 'BUYER', companyName: 'W Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'close-loser@test.com', role: 'BUYER', companyName: 'L Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'close-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
  ]);
  winnerId = winner.id; loserId = loser.id; sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Close Test Category', slug: 'close-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Close Test Lot', description: 'For close-job testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() - 1000), status: 'LIVE',
      currentHighestBidAmountCents: 120000, currentHighestBidderId: winnerId,
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId: winnerId, amountCents: 120000, status: 'WINNING' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: winnerId, amountCents: 10000, stripePaymentIntentId: 'pi_winner', status: 'AUTHORIZED' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: loserId, amountCents: 10000, stripePaymentIntentId: 'pi_loser', status: 'AUTHORIZED' } });
});

afterAll(async () => {
  const lotIds = [lotId, ...extraLotIds];
  await prisma.payment.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.depositHold.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.bid.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'Lot', entityId: { in: lotIds } } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, loserId, sellerId] } } });
  await competitor.$disconnect();
  await prisma.$disconnect();
});

describe('closeLots job', () => {
  it('marks an ended lot SOLD, releases the loser hold, and opens a payment window for the winner', async () => {
    await closeLots();

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.status).toBe('SOLD');

    const loserHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: loserId } });
    expect(loserHold.status).toBe('RELEASED');

    const winnerHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(winnerHold.status).toBe('AUTHORIZED');

    const payment = await prisma.payment.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(payment.status).toBe('PENDING');
    expect(payment.amountCents).toBe(120000 - winnerHold.amountCents);
  });

  // Regression test for the Lot row lock: without the FOR UPDATE re-read inside
  // the settlement transaction, both ticks settle the same lot off their own
  // stale snapshot and the winner gets charged twice.
  it('settles a lot exactly once when two ticks overlap', async () => {
    const raceLotId = await createEndedLot('Close Race Lot', winnerId, 130000);
    await prisma.depositHold.create({ data: { lotId: raceLotId, buyerId: winnerId, amountCents: 10000, stripePaymentIntentId: 'pi_race_winner', status: 'AUTHORIZED' } });
    await prisma.depositHold.create({ data: { lotId: raceLotId, buyerId: loserId, amountCents: 10000, stripePaymentIntentId: 'pi_race_loser', status: 'AUTHORIZED' } });
    cancelMock.mockClear();

    const results = await Promise.allSettled([closeLots(), closeLots()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: raceLotId } });
    expect(lot.status).toBe('SOLD');

    expect(await prisma.payment.count({ where: { lotId: raceLotId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: raceLotId, action: 'LOT_SOLD' } })).toBe(1);

    // The loser's hold is cancelled at Stripe once, not once per tick; the
    // winner's hold is never cancelled.
    expect(cancelCallsFor('pi_race_loser')).toHaveLength(1);
    expect(cancelCallsFor('pi_race_winner')).toHaveLength(0);

    const loserHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId: raceLotId, buyerId: loserId } });
    expect(loserHold.status).toBe('RELEASED');
    const winnerHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId: raceLotId, buyerId: winnerId } });
    expect(winnerHold.status).toBe('AUTHORIZED');
  });

  // The settlement transaction must not depend on Stripe: a failing (or slow)
  // cancel used to roll the whole transaction back after some cancels had
  // already been sent, leaving the lot LIVE forever and re-cancelling
  // already-cancelled intents on every later tick.
  it('settles the lot even when Stripe cancel fails, then releases the hold idempotently on the next tick', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stuckLotId = await createEndedLot('Close Stripe Failure Lot', null, null);
      await prisma.depositHold.create({ data: { lotId: stuckLotId, buyerId: loserId, amountCents: 10000, stripePaymentIntentId: 'pi_stuck', status: 'AUTHORIZED' } });

      cancelMock.mockClear();
      cancelMock.mockRejectedValueOnce(new Error('stripe unreachable'));
      await closeLots();

      // Committed regardless of Stripe...
      expect((await prisma.lot.findUniqueOrThrow({ where: { id: stuckLotId } })).status).toBe('UNSOLD');
      expect(await prisma.auditLog.count({ where: { entityId: stuckLotId, action: 'LOT_UNSOLD' } })).toBe(1);
      // ...and the hold is handed back so the next tick retries it.
      expect((await prisma.depositHold.findFirstOrThrow({ where: { lotId: stuckLotId } })).status).toBe('AUTHORIZED');
      expect(cancelCallsFor('pi_stuck')).toHaveLength(1);

      // Next tick: Stripe now reports the intent as no longer cancellable
      // (already cancelled). That must count as success, not an error loop.
      cancelMock.mockRejectedValueOnce(Object.assign(new Error('cannot be cancelled'), { code: 'payment_intent_unexpected_state' }));
      await expect(closeLots()).resolves.toBeUndefined();

      expect((await prisma.depositHold.findFirstOrThrow({ where: { lotId: stuckLotId } })).status).toBe('RELEASED');
      expect(cancelCallsFor('pi_stuck')).toHaveLength(2);
    } finally {
      cancelMock.mockResolvedValue({});
      errors.mockRestore();
    }
  });

  // Without SET LOCAL lock_timeout the FOR UPDATE wait is unbounded (Prisma's
  // transaction timeout does not cancel it), and without a per-lot try/catch one
  // contended lot takes every other lot in the batch down with it.
  it('skips only the lot whose row lock is held, and still settles the rest of the batch', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const contendedLotId = await createEndedLot('Close Contended Lot', null, null);
      const innocentLotId = await createEndedLot('Close Innocent Lot', null, null);

      const HOLD_LOCK_SECONDS = 8; // > the job's 3000ms lock_timeout
      // pg_sleep()::text — the raw void return fails Prisma's column deserializer.
      const holding = competitor.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${contendedLotId} FOR UPDATE`;
          await tx.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_LOCK_SECONDS})::text`);
        },
        { timeout: (HOLD_LOCK_SECONDS + 10) * 1000 }
      );
      await new Promise((r) => setTimeout(r, 300)); // let the competitor actually take the lock

      const startedAt = Date.now();
      await expect(closeLots()).resolves.toBeUndefined();
      const elapsedMs = Date.now() - startedAt;

      // Gave up on the lock instead of waiting the competitor out.
      expect(elapsedMs).toBeLessThan(HOLD_LOCK_SECONDS * 1000);
      expect((await prisma.lot.findUniqueOrThrow({ where: { id: contendedLotId } })).status).toBe('LIVE');
      // The uncontended lot in the same batch was NOT skipped.
      expect((await prisma.lot.findUniqueOrThrow({ where: { id: innocentLotId } })).status).toBe('UNSOLD');

      await holding;
    } finally {
      errors.mockRestore();
    }
  }, 30_000);
});
