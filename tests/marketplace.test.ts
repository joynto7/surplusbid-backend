import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { resetCatalogCache } from '../src/modules/ai/catalog';
import { parseSearchHeuristic } from '../src/modules/ai/searchIntent';
import { editDistance } from '../src/modules/ai/text';
import { stem } from '../src/modules/lots/lots.service';
import { signAccessToken } from '../src/utils/jwt';

// A fresh client address per run, so the per-caller rate limits never carry over between runs.
const CLIENT_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const tag = randomUUID().slice(0, 8);

let sellerId: string, winnerId: string, otherBuyerId: string, adminId: string, categoryId: string, otherCategoryId: string;
let forkliftId: string, truckId: string, draftId: string, soldId: string, liveUnsoldId: string;
let sellerToken: string, winnerToken: string, otherToken: string, adminToken: string;

const day = 86_400_000;

beforeAll(async () => {
  const [seller, winner, other, admin] = await Promise.all([
    prisma.user.create({
      data: { email: `mk-seller-${tag}@test.com`, role: 'SELLER', companyName: `Harbor Test ${tag}`, passwordHash: 'x', verificationStatus: 'VERIFIED' },
    }),
    prisma.user.create({ data: { email: `mk-winner-${tag}@test.com`, role: 'BUYER', companyName: 'Winner Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: `mk-other-${tag}@test.com`, role: 'BUYER', companyName: 'Other Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: `mk-admin-${tag}@test.com`, role: 'ADMIN', companyName: 'Admin', passwordHash: 'x' } }),
  ]);
  sellerId = seller.id;
  winnerId = winner.id;
  otherBuyerId = other.id;
  adminId = admin.id;
  sellerToken = signAccessToken({ id: sellerId, role: 'SELLER' });
  winnerToken = signAccessToken({ id: winnerId, role: 'BUYER' });
  otherToken = signAccessToken({ id: otherBuyerId, role: 'BUYER' });
  adminToken = signAccessToken({ id: adminId, role: 'ADMIN' });

  const [cat, otherCat] = await Promise.all([
    prisma.category.create({ data: { name: `Vehicles ${tag}`, slug: `vehicles-${tag}` } }),
    prisma.category.create({ data: { name: `Furniture ${tag}`, slug: `furniture-${tag}` } }),
  ]);
  categoryId = cat.id;
  otherCategoryId = otherCat.id;

  const base = {
    sellerId,
    description: 'Fleet unit with records. Loads by forklift at our dock.',
    quantity: 1,
    reservePriceCents: 1_200_000,
    bidIncrementCents: 10_000,
    startTime: new Date(Date.now() - 2 * day),
    endTime: new Date(Date.now() + 3 * day),
  };
  const lots = await Promise.all([
    prisma.lot.create({
      data: {
        ...base, categoryId, title: `LPG Forklift ${tag}`, condition: 'Used - good', location: 'Long Beach, CA',
        startingPriceCents: 900_000, status: 'LIVE',
      },
    }),
    prisma.lot.create({
      data: {
        ...base, categoryId, title: `Box Truck ${tag}`, condition: 'Used - excellent', location: 'Chicago, IL',
        startingPriceCents: 2_400_000, status: 'LIVE',
      },
    }),
    prisma.lot.create({
      data: {
        ...base, categoryId, title: `Draft Trailer ${tag}`, condition: 'Used - fair', location: 'Austin, TX',
        startingPriceCents: 500_000, status: 'DRAFT',
      },
    }),
    prisma.lot.create({
      data: {
        ...base, categoryId: otherCategoryId, title: `Task Chairs ${tag}`, condition: 'Used - good', location: 'Chicago, IL',
        startingPriceCents: 300_000, status: 'SOLD', currentHighestBidAmountCents: 420_000, currentHighestBidderId: winner.id,
        startTime: new Date(Date.now() - 10 * day), endTime: new Date(Date.now() - 3 * day),
      },
    }),
    prisma.lot.create({
      data: {
        ...base, categoryId: otherCategoryId, title: `Conference Table ${tag}`, condition: 'New', location: 'Chicago, IL',
        startingPriceCents: 200_000, status: 'LIVE',
      },
    }),
  ]);
  [forkliftId, truckId, draftId, soldId, liveUnsoldId] = lots.map((l) => l.id) as [string, string, string, string, string];
  await prisma.bid.createMany({
    data: [
      { lotId: soldId, buyerId: otherBuyerId, amountCents: 350_000, status: 'OUTBID', createdAt: new Date(Date.now() - 5 * day) },
      { lotId: soldId, buyerId: winnerId, amountCents: 420_000, status: 'WINNING', createdAt: new Date(Date.now() - 4 * day) },
      { lotId: forkliftId, buyerId: otherBuyerId, amountCents: 910_000, status: 'WINNING', createdAt: new Date(Date.now() - 3_600_000) },
    ],
  });
  // What placeBid writes; the lot_current_price trigger then moves currentPriceCents.
  await prisma.lot.update({
    where: { id: forkliftId },
    data: { currentHighestBidAmountCents: 910_000, currentHighestBidderId: otherBuyerId },
  });
  resetCatalogCache();
});

afterAll(async () => {
  const lotIds = [forkliftId, truckId, draftId, soldId, liveUnsoldId];
  await prisma.review.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.dispute.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.lotView.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.bid.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
  await prisma.category.deleteMany({ where: { id: { in: [categoryId, otherCategoryId] } } });
  await prisma.contactMessage.deleteMany({ where: { email: `contact-${tag}@test.com` } });
  await prisma.newsletterSubscriber.deleteMany({ where: { email: `news-${tag}@test.com` } });
  await prisma.user.deleteMany({ where: { id: { in: [sellerId, winnerId, otherBuyerId, adminId] } } });
  await prisma.$disconnect();
});

const api = () => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('X-Client-IP', CLIENT_IP),
  post: (path: string) => request(app).post(`/api/v1${path}`).set('X-Client-IP', CLIENT_IP),
});

describe('search helpers', () => {
  it('stems plurals so a search for forklifts finds a Forklift', () => {
    expect(stem('forklifts')).toBe('forklift');
    expect(stem('batteries')).toBe('battery');
    expect(stem('boxes')).toBe('box');
    expect(stem('glass')).toBe('glass');
    expect(stem('beds')).toBe('beds');
  });

  it('measures typos with transpositions counted once', () => {
    expect(editDistance('forklfit', 'forklift')).toBe(1);
    expect(editDistance('server', 'servers')).toBe(1);
    expect(editDistance('lathe', 'ladder', 1)).toBeGreaterThan(1);
  });

  it('reads prices, places, conditions, sorts and categories from a sentence', () => {
    const categories = [{ id: 'veh', name: 'Vehicles', slug: 'vehicles' }];
    const intent = parseSearchHeuristic('cheapest used forklift under $15k near Long Beach', categories, ['Long Beach, CA']);
    expect(intent).toMatchObject({
      q: 'forklift',
      categoryId: 'veh',
      maxPriceCents: 1_500_000,
      location: 'Long Beach',
      condition: 'Used',
      sort: 'price_asc',
    });
    expect(parseSearchHeuristic('between 2k and 8k in Texas', categories)).toMatchObject({
      minPriceCents: 200_000,
      maxPriceCents: 800_000,
      location: 'TX',
    });
    // Alternatives inside one category become a category search, not "a lot that is both".
    expect(parseSearchHeuristic('forklifts or box trucks', categories)).toMatchObject({ q: '', categoryId: 'veh' });
  });
});

describe('catalogue', () => {
  it('filters by price range, state code and condition', async () => {
    const res = await api().get(`/lots?categoryId=${categoryId}&maxPriceCents=1500000&location=CA&condition=used`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((l: { id: string }) => l.id)).toEqual([forkliftId]);
    // "CA" must not match "Chicago, IL".
    const chicago = await api().get(`/lots?categoryId=${categoryId}&location=CA`);
    expect(chicago.body.data.items.every((l: { location: string }) => l.location.endsWith(', CA'))).toBe(true);
  });

  it('keeps drafts out of public results but shows them to admins', async () => {
    const anon = await api().get(`/lots?status=DRAFT&categoryId=${categoryId}`);
    expect(anon.body.data.meta.total).toBe(0);
    const admin = await api().get(`/lots?status=DRAFT&categoryId=${categoryId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(admin.body.data.items.map((l: { id: string }) => l.id)).toContain(draftId);
  });

  it('decorates cards with category, seller, bid count and a live price', async () => {
    const res = await api().get(`/lots?q=forklifts ${tag}`);
    const card = res.body.data.items[0];
    expect(card.id).toBe(forkliftId);
    expect(card.category.id).toBe(categoryId);
    expect(card.seller.companyName).toContain('Harbor Test');
    expect(card.bidCount).toBe(1);
    expect(card.currentPriceCents).toBe(910_000);
  });

  it('sorts by the live price', async () => {
    const res = await api().get(`/lots?categoryId=${categoryId}&status=LIVE&sortBy=currentPriceCents&sortOrder=desc`);
    expect(res.body.data.items.map((l: { id: string }) => l.id)).toEqual([truckId, forkliftId]);
  });

  it('hides the reserve from buyers and shows it, with its status, to the seller', async () => {
    const buyer = await api().get(`/lots/${forkliftId}`).set('Authorization', `Bearer ${otherToken}`);
    expect(buyer.body.data.reservePriceCents).toBeUndefined();
    expect(buyer.body.data.reserveMet).toBeUndefined();
    const owner = await api().get(`/lots/${forkliftId}`).set('Authorization', `Bearer ${sellerToken}`);
    expect(owner.body.data.reservePriceCents).toBe(1_200_000);
    expect(owner.body.data.reserveMet).toBe(false);
  });

  it('suggests related live lots from the same category first', async () => {
    const res = await api().get(`/lots/${forkliftId}/related?limit=4`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((l: { id: string }) => l.id);
    expect(ids[0]).toBe(truckId);
    expect(ids).not.toContain(forkliftId);
    expect(ids).not.toContain(draftId);
  });

  it('counts a viewer once per half hour', async () => {
    const viewerId = `viewer-${tag}`;
    const first = await api().post(`/lots/${liveUnsoldId}/view`).send({ viewerId });
    const second = await api().post(`/lots/${liveUnsoldId}/view`).send({ viewerId });
    expect(first.body.data.counted).toBe(true);
    expect(second.body.data.counted).toBe(false);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: liveUnsoldId } });
    expect(lot.viewCount).toBe(1);
  });

  it('includes live lot counts on categories', async () => {
    const res = await api().get('/categories');
    const vehicles = res.body.data.find((c: { id: string }) => c.id === categoryId);
    expect(vehicles.liveLotCount).toBe(2);
  });
});

describe('reviews', () => {
  it('lets only the winning buyer review a sold lot, once', async () => {
    const body = { lotId: soldId, rating: 4, title: 'Solid chairs', comment: 'All thirty chairs arrived as described.' };
    const outsider = await api().post('/reviews').set('Authorization', `Bearer ${otherToken}`).send(body);
    expect(outsider.status).toBe(403);
    const liveLot = await api().post('/reviews').set('Authorization', `Bearer ${winnerToken}`).send({ ...body, lotId: liveUnsoldId });
    expect(liveLot.status).toBe(409);
    const created = await api().post('/reviews').set('Authorization', `Bearer ${winnerToken}`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.seller.id).toBe(sellerId);
    const again = await api().post('/reviews').set('Authorization', `Bearer ${winnerToken}`).send(body);
    expect(again.status).toBe(409);
  });

  it('rejects out-of-range ratings', async () => {
    const res = await api()
      .post('/reviews')
      .set('Authorization', `Bearer ${winnerToken}`)
      .send({ lotId: soldId, rating: 6, title: 'Too many stars', comment: 'Six out of five is not a thing.' });
    expect(res.status).toBe(422);
  });

  it('summarizes a seller with a star distribution', async () => {
    const res = await api().get(`/sellers/${sellerId}/reviews`);
    expect(res.body.data.summary).toMatchObject({ average: 4, count: 1, distribution: { 4: 1, 5: 0 } });
  });
});

describe('contact and newsletter', () => {
  it('validates and stores contact messages', async () => {
    const bad = await api().post('/contact').send({ name: 'A', email: 'nope', topic: 'buying', message: 'short' });
    expect(bad.status).toBe(422);
    const ok = await api()
      .post('/contact')
      .send({ name: 'Test Buyer', email: `contact-${tag}@test.com`, topic: 'buying', message: 'Can we inspect the forklift on Tuesday?' });
    expect(ok.status).toBe(201);
  });

  it('subscribes an address once', async () => {
    const first = await api().post('/newsletter').send({ email: `News-${tag}@test.com` });
    const second = await api().post('/newsletter').send({ email: `news-${tag}@test.com` });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
  });
});

describe('AI features without a model key', () => {
  it('turns a sentence into filters', async () => {
    const res = await api().post('/ai/search-intent').send({ q: `${tag} vehicles under $10,000 in CA` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ maxPriceCents: 1_000_000, location: 'CA', mode: 'smart' });
  });

  it('corrects typos in suggestions', async () => {
    const res = await api().get(`/ai/suggest?q=forklfit ${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lots.map((l: { id: string }) => l.id)).toContain(forkliftId);
  });

  it('answers policy questions from the knowledge base', async () => {
    const res = await api()
      .post('/ai/chat')
      .send({ messages: [{ role: 'user', content: 'When is my deposit hold released?' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('smart');
    expect(res.body.data.reply).toMatch(/released automatically/i);
  });

  it('requires the last chat message to come from the user', async () => {
    const res = await api().post('/ai/chat').send({ messages: [{ role: 'assistant', content: 'Hi!' }] });
    expect(res.status).toBe(422);
  });

  it('explains trending picks and personalizes recommendations', async () => {
    const trending = await api().get('/ai/trending?limit=24');
    expect(trending.status).toBe(200);
    expect(trending.body.data.every((l: { reason: string }) => l.reason.length > 0)).toBe(true);
    const recs = await api().get(`/ai/recommendations?seed=${forkliftId}&limit=6`);
    expect(recs.body.data.strategy).toBe('personalized');
    expect(recs.body.data.items.map((l: { id: string }) => l.id)).not.toContain(forkliftId);
  });

  it('drafts a listing with price guidance for sellers only', async () => {
    const buyer = await api().post('/ai/listing-assist').set('Authorization', `Bearer ${winnerToken}`).send({ title: 'Office chairs' });
    expect(buyer.status).toBe(403);
    const seller = await api()
      .post('/ai/listing-assist')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Ergonomic task chairs', categoryId: otherCategoryId, condition: 'Used - good', notes: 'Brand: Steelcase\nQuantity note: 30 chairs' });
    expect(seller.status).toBe(200);
    expect(seller.body.data.description).toContain('good used condition');
    expect(seller.body.data.specs).toEqual(expect.arrayContaining([{ label: 'Brand', value: 'Steelcase' }]));
  });

  it('infers common specs from free-text notes without repeating them in the description', async () => {
    const res = await api()
      .post('/ai/listing-assist')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ title: 'Hyster H50FT forklift, 5,000 lb, LPG', notes: '4,200 hours, side shift, serviced every 250 hours' });
    expect(res.status).toBe(200);
    expect(res.body.data.specs).toEqual([
      { label: 'Hours', value: '4,200' },
      { label: 'Capacity', value: '5,000 lb' },
      { label: 'Fuel / power', value: 'LPG' },
    ]);
    expect(res.body.data.description).not.toContain('Key details');
  });
});

describe('admin analytics and disputes', () => {
  it('restricts analytics to admins and returns full series', async () => {
    const buyer = await api().get('/admin/analytics').set('Authorization', `Bearer ${winnerToken}`);
    expect(buyer.status).toBe(403);
    const res = await api().get('/admin/analytics').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.bidsPerDay).toHaveLength(30);
    expect(res.body.data.gmvPerMonth).toHaveLength(6);
  });

  it('computes insights and a summary', async () => {
    const res = await api().get('/admin/ai-insights').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.summary).toBe('string');
    expect(Array.isArray(res.body.data.insights)).toBe(true);
    expect(res.body.data.bidSeries).toHaveLength(30);
  });

  it('lists disputes for admins and for the parties', async () => {
    const filed = await api()
      .post('/disputes')
      .set('Authorization', `Bearer ${winnerToken}`)
      .send({ lotId: soldId, reason: 'Item not as described', description: 'Two chairs have broken gas cylinders.' });
    expect(filed.status).toBe(201);
    const admin = await api().get(`/disputes?status=OPEN&q=${tag}`).set('Authorization', `Bearer ${adminToken}`);
    expect(admin.body.data.items.map((d: { id: string }) => d.id)).toContain(filed.body.data.id);
    const seller = await api().get('/disputes/mine').set('Authorization', `Bearer ${sellerToken}`);
    expect(seller.body.data.items.map((d: { id: string }) => d.id)).toContain(filed.body.data.id);
    const outsider = await api().get('/disputes/mine').set('Authorization', `Bearer ${otherToken}`);
    expect(outsider.body.data.items.map((d: { id: string }) => d.id)).not.toContain(filed.body.data.id);
  });
});
