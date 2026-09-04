import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';
import { stripe } from '../src/config/stripe';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_test_123', client_secret: 'secret_123' }) } },
}));

let buyerId: string, sellerId: string, categoryId: string, lotId: string, buyerToken: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'deposit-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ id: buyer.id, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'deposit-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Deposit Test Category', slug: 'deposit-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Deposit Test Lot', description: 'For deposit testing',
      condition: 'Used', quantity: 1, startingPriceCents: 200000, reservePriceCents: 150000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
});

afterAll(async () => {
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Deposit hold', () => {
  it('creates a Stripe payment intent and stores an AUTHORIZED hold at 10% of startingPriceCents', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/deposit`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(201);
    expect(res.body.data.amountCents).toBe(20000);
    expect(res.body.data.status).toBe('AUTHORIZED');
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20000, currency: 'usd', capture_method: 'manual' })
    );
  });

  it('rejects a second deposit request for the same lot/buyer pair', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/deposit`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(409);
  });
});
