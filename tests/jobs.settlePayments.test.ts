import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { sweepOverduePayments } from '../src/jobs/settlePayments.job';

jest.mock('../src/config/stripe', () => ({
  stripe: {
    paymentIntents: {
      capture: jest.fn().mockResolvedValue({}),
      retrieve: jest.fn(),
    },
  },
}));

let sellerId: string, categoryId: string, lotId: string, winnerId: string, nextBidderId: string;

beforeAll(async () => {
  const [winner, nextBidder, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'settle-winner@test.com', role: 'BUYER', companyName: 'W Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'settle-next@test.com', role: 'BUYER', companyName: 'N Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'settle-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
  ]);
  winnerId = winner.id; nextBidderId = nextBidder.id; sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Settle Test Category', slug: 'settle-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Settle Test Lot', description: 'For settlement testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(Date.now() - 7_200_000), endTime: new Date(Date.now() - 3_600_000), status: 'SOLD',
      currentHighestBidAmountCents: 120000, currentHighestBidderId: winnerId,
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId: winnerId, amountCents: 120000, status: 'WINNING' } });
  await prisma.bid.create({ data: { lotId, buyerId: nextBidderId, amountCents: 115000, status: 'OUTBID' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: winnerId, amountCents: 10000, stripePaymentIntentId: 'pi_settle_winner', status: 'AUTHORIZED' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: nextBidderId, amountCents: 10000, stripePaymentIntentId: 'pi_settle_next', status: 'AUTHORIZED' } });
  await prisma.payment.create({
    data: { lotId, buyerId: winnerId, amountCents: 110000, status: 'PENDING', dueAt: new Date(Date.now() - 1000) },
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: { in: ['Lot', 'Payment'] }, entityId: lotId } });
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, nextBidderId, sellerId] } } });
  // No redis.quit() here: tests/setupRedisTeardown.ts already quits the
  // shared redis client once per test file via its own global afterAll
  // (same singleton import) — calling quit() a second time throws
  // "Connection is closed." (established by Task 10's fix; no other test
  // file that touches redis calls quit() itself either).
  await prisma.$disconnect();
});

describe('sweepOverduePayments', () => {
  it('forfeits the missed-deadline winner and rolls the lot to the next-highest bidder', async () => {
    await sweepOverduePayments();

    const winnerHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(winnerHold.status).toBe('CAPTURED');

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.currentHighestBidderId).toBe(nextBidderId);
    expect(lot.status).toBe('SOLD');

    const nextPayment = await prisma.payment.findFirstOrThrow({ where: { lotId, buyerId: nextBidderId } });
    expect(nextPayment.status).toBe('PENDING');
    expect(nextPayment.amountCents).toBe(115000 - 10000);

    const cachedHighest = await redis.get(`lot:${lotId}:highestBid`);
    expect(Number(cachedHighest)).toBe(115000);

    const auditActions = await prisma.auditLog.findMany({ where: { entityId: { in: [lotId, ...(await prisma.payment.findMany({ where: { lotId }, select: { id: true } })).map((p) => p.id)] } } });
    expect(auditActions.map((a) => a.action)).toEqual(expect.arrayContaining(['PAYMENT_DEADLINE_FORFEITED', 'LOT_ROLLED_OVER']));
  });
});
