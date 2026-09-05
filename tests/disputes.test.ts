import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string, sellerId: string, adminId: string, outsiderId: string, categoryId: string, lotId: string;
let buyerToken: string, adminToken: string, outsiderToken: string, disputeId: string;

beforeAll(async () => {
  const [buyer, seller, admin, outsider] = await Promise.all([
    prisma.user.create({ data: { email: 'dispute-buyer@test.com', role: 'BUYER', companyName: 'B Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'dispute-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'dispute-admin@test.com', role: 'ADMIN', companyName: 'Admin', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'dispute-outsider@test.com', role: 'BUYER', companyName: 'O Co', passwordHash: 'x' } }),
  ]);
  buyerId = buyer.id; sellerId = seller.id; adminId = admin.id; outsiderId = outsider.id;
  buyerToken = signAccessToken({ id: buyerId, role: 'BUYER' });
  adminToken = signAccessToken({ id: adminId, role: 'ADMIN' });
  outsiderToken = signAccessToken({ id: outsiderId, role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Dispute Test Category', slug: 'dispute-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Dispute Test Lot', description: 'For dispute testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'SOLD',
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId, amountCents: 85000, status: 'WINNING' } });
});

afterAll(async () => {
  await prisma.dispute.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId, adminId, outsiderId] } } });
  await prisma.$disconnect();
});

describe('Disputes', () => {
  it('rejects a dispute from someone with no stake in the lot', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ lotId, reason: 'Not my business', description: 'I am not involved in this lot at all.' });
    expect(res.status).toBe(403);
  });

  it('lets a buyer file a dispute on a lot', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, reason: 'Item not as described', description: 'The equipment had undisclosed damage.' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('OPEN');
    disputeId = res.body.data.id;
  });

  it('rejects resolution attempts from a non-admin', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ status: 'RESOLVED', resolutionNote: 'Refund issued' });
    expect(res.status).toBe(403);
  });

  it('lets an admin resolve the dispute', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RESOLVED', resolutionNote: 'Refund issued to buyer' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RESOLVED');
    expect(res.body.data.resolvedById).toBe(adminId);
  });
});
