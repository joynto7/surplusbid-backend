import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { signAccessToken } from '../src/utils/jwt';

let sellerId: string, categoryId: string, lotId: string;

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: 'browse-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x', verificationStatus: 'VERIFIED' },
  });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Browse Test Category', slug: 'browse-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Industrial Generator', description: 'A generator for the browse test',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: sellerId } });
  await redis.quit();
  await prisma.$disconnect();
});

describe('Lot browse', () => {
  it('paginates lot listings', async () => {
    const res = await request(app).get('/api/v1/lots?page=1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(5);
    expect(res.body.data.meta.page).toBe(1);
  });

  it('filters by category and status', async () => {
    const res = await request(app).get(`/api/v1/lots?categoryId=${categoryId}&status=LIVE`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.every((l: { categoryId: string }) => l.categoryId === categoryId)).toBe(true);
  });

  it('searches by keyword in the title', async () => {
    const res = await request(app).get('/api/v1/lots?q=Generator');
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((l: { id: string }) => l.id === lotId)).toBe(true);
  });

  it('gets a single lot by id, hiding reservePriceCents from a non-owner', async () => {
    const token = signAccessToken({ id: 'someone-else', role: 'BUYER' });
    const res = await request(app).get(`/api/v1/lots/${lotId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reservePriceCents).toBeUndefined();
  });
});
