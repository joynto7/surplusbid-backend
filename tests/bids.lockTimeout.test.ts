import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { create: jest.fn(async () => ({ id: `pi_${Math.random()}` })) } },
}));

// Own client, own connection pool: this is what makes the competing lock real
// rather than a mock. Nothing here shares a connection with the app's prisma.
const competitor = new PrismaClient();

const HOLD_LOCK_SECONDS = 5; // > placeBid's 3000ms lock_timeout, so the bid must lose the wait

let buyerId: string, sellerId: string, categoryId: string, lotId: string, token: string;

beforeAll(async () => {
  const [buyer, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'locktimeout-buyer@test.com', role: 'BUYER', companyName: 'B Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'locktimeout-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } }),
  ]);
  buyerId = buyer.id; sellerId = seller.id;
  token = signAccessToken({ id: buyerId, role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Lock Timeout Category', slug: 'lock-timeout-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Lock Timeout Lot', description: 'For lock-contention testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;

  await request(app).post(`/api/v1/lots/${lotId}/deposit`).set('Authorization', `Bearer ${token}`);
});

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await competitor.$disconnect();
  await prisma.$disconnect();
});

describe('Bid placement under a lock wait longer than lock_timeout', () => {
  it('answers 503, not 500, when the Lot row lock is held past lock_timeout', async () => {
    // Hold the row lock on this exact lot from the independent connection.
    // pg_sleep()::text — the raw void return fails Prisma's column deserializer.
    const holding = competitor.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lotId} FOR UPDATE`;
        await tx.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_LOCK_SECONDS})::text`);
      },
      { timeout: (HOLD_LOCK_SECONDS + 10) * 1000 }
    );
    await new Promise((r) => setTimeout(r, 300)); // let the competitor actually take the lock

    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/bids`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amountCents: 105000 });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, message: 'The server is busy, please try again', errors: [] });

    await holding;
    // The abandoned bid rolled back cleanly: no half-written bid row.
    expect(await prisma.bid.count({ where: { lotId } })).toBe(0);
  }, 30_000);
});
