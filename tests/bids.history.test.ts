import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string, sellerId: string, categoryId: string, lotId: string, token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'history-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyerId, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'history-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'History Test Category', slug: 'history-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'History Test Lot', description: 'For bid history testing',
      condition: 'Used', quantity: 1, startingPriceCents: 50000, reservePriceCents: 40000, bidIncrementCents: 1000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId, amountCents: 51000, status: 'WINNING' } });
});

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Bid history', () => {
  it('returns paginated bid history for a lot, newest first', async () => {
    const res = await request(app).get(`/api/v1/lots/${lotId}/bids`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].amountCents).toBe(51000);
  });

  it("returns the authenticated buyer's own bids", async () => {
    const res = await request(app).get('/api/v1/bids/my-bids').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((b: { lotId: string }) => b.lotId === lotId)).toBe(true);
  });

  it('does not expose buyerId on the public bid history endpoint', async () => {
    const res = await request(app).get(`/api/v1/lots/${lotId}/bids`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).not.toHaveProperty('buyerId');
  });

  it('rejects invalid page/limit on the public bid history endpoint with 422', async () => {
    const badPage = await request(app).get(`/api/v1/lots/${lotId}/bids`).query({ page: 'abc' });
    expect(badPage.status).toBe(422);
    expect(Array.isArray(badPage.body.errors)).toBe(true);
    expect(badPage.body.errors.length).toBeGreaterThan(0);

    const negativePage = await request(app).get(`/api/v1/lots/${lotId}/bids`).query({ page: -1 });
    expect(negativePage.status).toBe(422);

    const zeroLimit = await request(app).get(`/api/v1/lots/${lotId}/bids`).query({ limit: 0 });
    expect(zeroLimit.status).toBe(422);
  });

  it('rejects invalid page/limit on my-bids with 422', async () => {
    const badPage = await request(app)
      .get('/api/v1/bids/my-bids')
      .set('Authorization', `Bearer ${token}`)
      .query({ page: 'abc' });
    expect(badPage.status).toBe(422);

    const zeroLimit = await request(app)
      .get('/api/v1/bids/my-bids')
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: 0 });
    expect(zeroLimit.status).toBe(422);
  });
});
