import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let sellerId: string;
let categoryId: string;
let sellerToken: string;
let buyerToken: string;

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: 'lot-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x', verificationStatus: 'VERIFIED' },
  });
  sellerId = seller.id;
  sellerToken = signAccessToken({ id: seller.id, role: 'SELLER' });
  buyerToken = signAccessToken({ id: 'nonexistent-buyer', role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Test Lots Category', slug: 'test-lots-category' } });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: sellerId } });
  await prisma.$disconnect();
});

describe('Lot CRUD', () => {
  let lotId: string;

  it('lets a seller create a draft lot', async () => {
    const res = await request(app)
      .post('/api/v1/lots')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        title: 'Used Forklift',
        description: 'Well-maintained forklift, 2019 model',
        categoryId,
        condition: 'Used - Good',
        quantity: 1,
        startingPriceCents: 500000,
        reservePriceCents: 400000,
        bidIncrementCents: 10000,
        startTime: new Date(Date.now() + 60_000).toISOString(),
        endTime: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    lotId = res.body.data.id;
  });

  it('rejects a PATCH that puts endTime before startTime', async () => {
    const res = await request(app)
      .patch(`/api/v1/lots/${lotId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        startTime: new Date(Date.now() + 3_600_000).toISOString(),
        endTime: new Date(Date.now() + 60_000).toISOString(),
      });
    expect(res.status).toBe(422);
  });

  it('allows a PATCH touching only one of the time fields (or neither)', async () => {
    const onlyTitle = await request(app)
      .patch(`/api/v1/lots/${lotId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Used Forklift (Updated)' });
    expect(onlyTitle.status).toBe(200);

    const onlyStartTime = await request(app)
      .patch(`/api/v1/lots/${lotId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ startTime: new Date(Date.now() + 30_000).toISOString() });
    expect(onlyStartTime.status).toBe(200);
  });

  it('rejects a buyer trying to create a lot', async () => {
    const res = await request(app)
      .post('/api/v1/lots')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ title: 'x' });
    expect(res.status).toBe(403);
  });

  it('lets the owning seller publish the draft', async () => {
    const res = await request(app)
      .patch(`/api/v1/lots/${lotId}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('LIVE');
  });

  it('lists the seller their own listings', async () => {
    const res = await request(app)
      .get('/api/v1/lots/my-listings')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((l: { id: string }) => l.id === lotId)).toBe(true);
  });

  it('soft-deletes the lot instead of hard-deleting it', async () => {
    const res = await request(app)
      .delete(`/api/v1/lots/${lotId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    const row = await prisma.lot.findUnique({ where: { id: lotId } });
    expect(row?.deletedAt).not.toBeNull();
  });
});
