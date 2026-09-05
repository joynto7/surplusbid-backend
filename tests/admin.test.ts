import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let adminId: string, pendingSellerId: string, adminToken: string, buyerToken: string;

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: 'admin-test@test.com', role: 'ADMIN', companyName: 'Admin', passwordHash: 'x' } });
  adminId = admin.id;
  adminToken = signAccessToken({ id: adminId, role: 'ADMIN' });
  buyerToken = signAccessToken({ id: 'someone', role: 'BUYER' });
  const pendingSeller = await prisma.user.create({
    data: { email: 'pending-seller@test.com', role: 'SELLER', companyName: 'Pending Co', passwordHash: 'x', verificationStatus: 'PENDING' },
  });
  pendingSellerId = pendingSeller.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, pendingSellerId] } } });
  await prisma.$disconnect();
});

describe('Admin', () => {
  it('rejects non-admins from listing users', async () => {
    const res = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
  });

  it('lists users filtered by verificationStatus, paginated', async () => {
    const res = await request(app)
      .get('/api/v1/admin/users?verificationStatus=PENDING&page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((u: { id: string }) => u.id === pendingSellerId)).toBe(true);
  });

  it('verifies a pending seller and writes an audit log entry', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${pendingSellerId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verificationStatus: 'VERIFIED' });
    expect(res.status).toBe(200);
    expect(res.body.data.verificationStatus).toBe('VERIFIED');

    const log = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: pendingSellerId } });
    expect(log?.action).toBe('VERIFY_USER');
  });

  it('returns dashboard stats', async () => {
    const res = await request(app).get('/api/v1/admin/dashboard-stats').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('activeLots');
    expect(res.body.data).toHaveProperty('openDisputes');
  });

  it('lists audit logs, paginated', async () => {
    const res = await request(app).get('/api/v1/admin/audit-logs?page=1&limit=10').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });
});
