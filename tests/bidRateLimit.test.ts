import express from 'express';
import request from 'supertest';
import { bidRateLimit } from '../src/middleware/bidRateLimit';
import { errorHandler } from '../src/middleware/errorHandler';
import { redis } from '../src/config/redis';

const testApp = express();
testApp.use((req, _res, next) => { req.user = { id: 'rate-test-buyer', role: 'BUYER' }; next(); });
testApp.post('/lots/:id/bids', bidRateLimit, (_req, res) => res.json({ success: true }));
testApp.use(errorHandler);

// Clear the key up front rather than in afterAll: tests/setupRedisTeardown.ts's
// global afterAll quits the shared redis client before any afterAll declared in
// this file runs, so a redis call here would hit an already-closed connection.
beforeAll(async () => {
  await redis.del('bid-rate:rate-test-buyer:lot-1');
});

describe('bidRateLimit', () => {
  it('allows the first 5 bids on a lot within the window', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(testApp).post('/lots/lot-1/bids');
      expect(res.status).toBe(200);
    }
  });

  it('rejects the 6th bid within the same window with 429', async () => {
    const res = await request(testApp).post('/lots/lot-1/bids');
    expect(res.status).toBe(429);
  });
});
