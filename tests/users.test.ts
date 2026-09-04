import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string;
let token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({
    data: { email: 'profile-test@test.com', role: 'BUYER', companyName: 'Test Co', passwordHash: 'x' },
  });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyer.id, role: 'BUYER' });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: buyerId } });
  await prisma.$disconnect();
});

describe('Profile', () => {
  it('returns the current user on GET /users/me', async () => {
    const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('profile-test@test.com');
  });

  it('updates companyName on PATCH /users/me', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyName: 'Updated Co' });
    expect(res.status).toBe(200);
    expect(res.body.data.companyName).toBe('Updated Co');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});
