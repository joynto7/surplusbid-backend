import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: 'newbuyer@test.com' } });
  await prisma.$disconnect();
});

describe('Auth', () => {
  it('registers a new buyer and returns tokens', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'newbuyer@test.com',
      password: 'Passw0rd!',
      role: 'BUYER',
      companyName: 'Test Co',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects registration with an invalid email', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      password: 'Passw0rd!',
      role: 'BUYER',
      companyName: 'Test Co',
    });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'newbuyer@test.com',
      password: 'Passw0rd!',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects login with wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'newbuyer@test.com',
      password: 'wrong',
    });
    expect(res.status).toBe(401);
  });
});
