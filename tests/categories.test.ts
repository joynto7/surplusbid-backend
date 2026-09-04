import request from 'supertest';
import app from '../src/app';
import { signAccessToken } from '../src/utils/jwt';
import { prisma } from '../src/config/prisma';

afterAll(async () => {
  await prisma.category.deleteMany({ where: { slug: 'test-category' } });
  await prisma.$disconnect();
});

describe('Categories', () => {
  it('lists categories without auth', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects category creation from a non-admin', async () => {
    const token = signAccessToken({ id: 'u1', role: 'BUYER' });
    const res = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Category' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to create a category', async () => {
    const token = signAccessToken({ id: 'u1', role: 'ADMIN' });
    const res = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Category' });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('test-category');
  });
});
