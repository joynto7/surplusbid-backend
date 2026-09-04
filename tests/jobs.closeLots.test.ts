import { prisma } from '../src/config/prisma';
import { closeLots } from '../src/jobs/closeLots.job';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { cancel: jest.fn().mockResolvedValue({}) } },
}));

let sellerId: string, categoryId: string, lotId: string, winnerId: string, loserId: string;

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
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, loserId, sellerId] } } });
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
});
