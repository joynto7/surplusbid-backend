import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

jest.mock('../src/config/stripe', () => ({
  // one intent id per call: stripePaymentIntentId is @unique, so a fixed
  // mockResolvedValue would make the second buyer's deposit hold collide.
  stripe: { paymentIntents: { create: jest.fn(async () => ({ id: `pi_${Math.random()}` })) } },
}));

let buyerAId: string, buyerBId: string, sellerId: string, categoryId: string, lotId: string;
let tokenA: string, tokenB: string;

beforeAll(async () => {
  const [buyerA, buyerB, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'concurrency-a@test.com', role: 'BUYER', companyName: 'A Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'concurrency-b@test.com', role: 'BUYER', companyName: 'B Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'concurrency-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } }),
  ]);
  buyerAId = buyerA.id; buyerBId = buyerB.id; sellerId = seller.id;
  tokenA = signAccessToken({ id: buyerAId, role: 'BUYER' });
  tokenB = signAccessToken({ id: buyerBId, role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Concurrency Test Category', slug: 'concurrency-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Concurrency Test Lot', description: 'For race-condition testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;

  await request(app).post(`/api/v1/lots/${lotId}/deposit`).set('Authorization', `Bearer ${tokenA}`);
  await request(app).post(`/api/v1/lots/${lotId}/deposit`).set('Authorization', `Bearer ${tokenB}`);
});

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerAId, buyerBId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Concurrency-safe bidding', () => {
  it('rejects a bid below the minimum increment', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/bids`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ amountCents: 100001 });
    expect(res.status).toBe(409);
  });

  it('requires a deposit hold before accepting a bid', async () => {
    const unfundedToken = signAccessToken({ id: 'no-deposit-buyer', role: 'BUYER' });
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/bids`)
      .set('Authorization', `Bearer ${unfundedToken}`)
      .send({ amountCents: 105000 });
    expect(res.status).toBe(403);
  });

  it('never lets two simultaneous bids both become WINNING', async () => {
    const [resA, resB] = await Promise.all([
      request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenA}`).send({ amountCents: 110000 }),
      request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenB}`).send({ amountCents: 110000 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]); // one accepted, one rejected as no-longer-highest

    const winningBids = await prisma.bid.findMany({ where: { lotId, status: 'WINNING' } });
    expect(winningBids).toHaveLength(1);
  });

  it('extends endTime when a bid lands inside the anti-sniping window', async () => {
    await prisma.lot.update({ where: { id: lotId }, data: { endTime: new Date(Date.now() + 60_000) } });
    const before = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });

    await request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenA}`).send({ amountCents: 120000 });

    const after = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(after.endTime.getTime()).toBeGreaterThan(before.endTime.getTime());
  });
});
