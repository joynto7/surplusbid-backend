import express from 'express';
import request from 'supertest';
import { authenticate } from '../src/middleware/auth';
import { requireRole } from '../src/middleware/rbac';
import { errorHandler } from '../src/middleware/errorHandler';
import { signAccessToken } from '../src/utils/jwt';

const testApp = express();
testApp.get('/admin-only', authenticate, requireRole('ADMIN'), (_req, res) => res.json({ success: true }));
testApp.use(errorHandler);

describe('RBAC', () => {
  it('rejects a buyer token on an admin-only route with 403', async () => {
    const token = signAccessToken({ id: 'u1', role: 'BUYER' });
    const res = await request(testApp).get('/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows an admin token through', async () => {
    const token = signAccessToken({ id: 'u1', role: 'ADMIN' });
    const res = await request(testApp).get('/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a missing token with 401', async () => {
    const res = await request(testApp).get('/admin-only');
    expect(res.status).toBe(401);
  });
});
