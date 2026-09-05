import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

jest.mock('../src/config/stripe', () => ({
  stripe: {
    paymentIntents: { capture: jest.fn().mockResolvedValue({ id: 'pi_winner', status: 'succeeded' }) },
    webhooks: { constructEvent: jest.fn() },
  },
}));

import { stripe } from '../src/config/stripe';

let buyerId: string, sellerId: string, categoryId: string, lotId: string, paymentId: string, token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'payment-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyerId, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'payment-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Payment Test Category', slug: 'payment-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Payment Test Lot', description: 'For payment testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() - 1000), status: 'SOLD', currentHighestBidderId: buyerId,
    },
  });
  lotId = lot.id;
  await prisma.depositHold.create({ data: { lotId, buyerId, amountCents: 10000, stripePaymentIntentId: 'pi_winner', status: 'AUTHORIZED' } });
  const payment = await prisma.payment.create({
    data: { lotId, buyerId, amountCents: 110000, status: 'PENDING', dueAt: new Date(Date.now() + 3_600_000) },
  });
  paymentId = payment.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Final payment', () => {
  it('initiates payment by capturing the deposit hold and returns it as PENDING', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentId });
    expect(res.status).toBe(200);
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith('pi_winner');
  });

  it('marks the payment SUCCEEDED when the webhook reports success', async () => {
    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_winner' } },
    });
    const res = await request(app).post('/api/v1/payments/webhook').set('stripe-signature', 'test-sig').send({});
    expect(res.status).toBe(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('SUCCEEDED');
  });

  it("returns the buyer's own payments", async () => {
    const res = await request(app).get('/api/v1/payments/my-payments').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((p: { id: string }) => p.id === paymentId)).toBe(true);
  });
});
