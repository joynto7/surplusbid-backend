import { randomBytes } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { CATEGORIES, LOTS, MESSAGES, photo, REVIEWS, type SeedLot, SUBSCRIBERS, USERS } from './seed-data';

/**
 * Seeds the demo marketplace.
 *
 *   npm run seed                      demo accounts + categories, and the demo
 *                                     catalogue if the database has no lots yet
 *   SEED_RESET=true npm run seed      wipe everything first, then load it all
 *
 * The three demo logins (admin@, seller@, buyer@surplusbid.com) use the
 * password Passw0rd! on a fresh database; existing accounts keep theirs.
 * Other seeded businesses get random passwords: they exist to make the
 * marketplace real, not to be logged into.
 */

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Passw0rd!';
const DEPOSIT_PERCENT = Number(process.env.DEPOSIT_PERCENT ?? 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Deterministic random numbers, so every seed produces the same marketplace. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261020);
const between = (min: number, max: number) => min + rand() * (max - min);
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;

async function wipe() {
  // Children before parents.
  await prisma.$transaction([
    prisma.review.deleteMany(),
    prisma.lotView.deleteMany(),
    prisma.dispute.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.depositHold.deleteMany(),
    prisma.bid.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.lot.deleteMany(),
    prisma.category.deleteMany(),
    prisma.contactMessage.deleteMany(),
    prisma.newsletterSubscriber.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

async function seedAccounts(now: number) {
  const demoHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const ids = new Map<string, string>();
  for (const u of USERS) {
    const passwordHash = u.demo ? demoHash : await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    const profile = {
      contactName: u.contactName,
      phone: u.phone,
      location: u.location,
      ...(u.bio ? { bio: u.bio } : {}),
    };
    const user = await prisma.user.upsert({
      where: { email: u.email },
      // Existing accounts keep their password and verification state; fill in a missing profile only.
      update: {},
      create: {
        email: u.email,
        passwordHash,
        role: u.role,
        companyName: u.companyName,
        verificationStatus: u.verificationStatus,
        createdAt: new Date(now - u.joinedDaysAgo * DAY - between(0, 20) * HOUR),
        ...profile,
      },
    });
    if (!user.location) await prisma.user.update({ where: { id: user.id }, data: profile });
    ids.set(u.key, user.id);
  }
  return ids;
}

async function seedCategories() {
  const ids = new Map<string, string>();
  for (const c of CATEGORIES) {
    const data = { name: c.name, description: c.description, imageUrl: photo(c.image, 1200) };
    // Older databases created "Machinery" etc. without these slugs; match on name too.
    const existing = await prisma.category.findFirst({ where: { OR: [{ slug: c.slug }, { name: c.name }] } });
    const category = existing
      ? await prisma.category.update({ where: { id: existing.id }, data: { ...data, slug: c.slug } })
      : await prisma.category.create({ data: { ...data, slug: c.slug } });
    ids.set(c.slug, category.id);
  }
  return ids;
}

interface Timeline {
  start: Date;
  end: Date;
  createdAt: Date;
}

function timeline(lot: SeedLot, now: number): Timeline {
  if (lot.status === 'LIVE') {
    const end = now + (lot.endsInHours ?? 72) * HOUR;
    // Open long enough to have a history, but never in the future.
    const start = Math.min(end - lot.durationDays * DAY, now - between(3, 8) * DAY);
    return { start: new Date(start), end: new Date(end), createdAt: new Date(start - between(4, 30) * HOUR) };
  }
  if (lot.status === 'DRAFT') {
    const start = now + (lot.endsInHours ?? 24) * HOUR;
    return { start: new Date(start), end: new Date(start + lot.durationDays * DAY), createdAt: new Date(now - between(2, 20) * HOUR) };
  }
  const end = now - (lot.endedDaysAgo ?? 14) * DAY - between(0, 10) * HOUR;
  const start = end - lot.durationDays * DAY;
  return { start: new Date(start), end: new Date(end), createdAt: new Date(start - between(6, 48) * HOUR) };
}

/** Rising bid amounts from the first legal bid to the target, on the lot's increment grid. */
function bidAmounts(lot: SeedLot, count: number, targetDollars: number) {
  const startC = lot.startingPrice * 100;
  const incC = lot.increment * 100;
  const first = startC + incC;
  const target = Math.max(first + incC * (count - 1), Math.round(targetDollars * 100));
  const amounts: number[] = [];
  let current = startC;
  for (let i = 0; i < count; i++) {
    const remaining = count - i;
    const room = Math.max(incC, (target - current) / remaining);
    const step = Math.max(incC, Math.round((room * between(0.6, 1.4)) / incC) * incC);
    current = i === count - 1 ? Math.max(current + incC, Math.round(target / incC) * incC) : current + step;
    amounts.push(current);
  }
  return amounts;
}

/** Bid times between open and close (or now), leaning recent so live lots trend realistically. */
function bidTimes(count: number, from: number, to: number) {
  return Array.from({ length: count }, () => {
    const u = rand();
    return from + (to - from) * (1 - (1 - u) ** 1.6);
  }).sort((a, b) => a - b);
}

async function seedCatalogue(users: Map<string, string>, categories: Map<string, string>, now: number) {
  const id = (key: string) => {
    const value = users.get(key);
    if (!value) throw new Error(`Unknown seed user ${key}`);
    return value;
  };
  const buyerPool = USERS.filter((u) => u.role === 'BUYER' && u.verificationStatus === 'VERIFIED' && u.key !== 'demo-buyer').map(
    (u) => u.key
  );
  const lotIds = new Map<string, string>();
  const ends = new Map<string, Date>();
  const winners = new Map<string, string>();
  const bidRows: Prisma.BidCreateManyInput[] = [];
  const viewRows: Prisma.LotViewCreateManyInput[] = [];
  const auditRows: Prisma.AuditLogCreateManyInput[] = [];

  for (const lot of LOTS) {
    const { start, end, createdAt } = timeline(lot, now);
    const categoryId = categories.get(lot.category);
    if (!categoryId) throw new Error(`Unknown category ${lot.category}`);

    // Who bids: a rotating crowd, the named winner last, the demo buyer outbid mid-way on some live lots.
    const bidders: string[] = [];
    for (let i = 0; i < lot.bids; i++) {
      let next = pick(buyerPool);
      while (bidders.length && next === bidders[bidders.length - 1]) next = pick(buyerPool);
      bidders.push(next);
    }
    if (lot.status === 'SOLD' && lot.winner && bidders.length) {
      if (bidders[bidders.length - 2] === lot.winner) bidders[bidders.length - 2] = pick(buyerPool.filter((b) => b !== lot.winner));
      bidders[bidders.length - 1] = lot.winner;
    }
    if (lot.demoBuyerOutbid && bidders.length >= 3) bidders[Math.floor(bidders.length * 0.6)] = 'demo-buyer';

    const target =
      lot.status === 'SOLD'
        ? lot.startingPrice * (lot.finalMultiplier ?? 1.3)
        : lot.startingPrice * (1 + Math.min(0.85, lot.bids * between(0.03, 0.07)));
    const amounts = lot.bids ? bidAmounts(lot, lot.bids, target) : [];
    const times = lot.bids ? bidTimes(lot.bids, start.getTime() + 2 * HOUR, Math.min(end.getTime(), now) - 5 * 60_000) : [];
    const highest = amounts.length ? amounts[amounts.length - 1]! : null;
    const highestBidder = bidders.length ? id(bidders[bidders.length - 1]!) : null;

    const created = await prisma.lot.create({
      data: {
        sellerId: id(lot.seller),
        categoryId,
        title: lot.title,
        description: lot.description,
        images: lot.images.map((p) => photo(p)),
        condition: lot.condition,
        quantity: lot.quantity,
        location: lot.location,
        specs: lot.specs.map(([label, value]) => ({ label, value })),
        startingPriceCents: lot.startingPrice * 100,
        reservePriceCents: lot.reserve * 100,
        bidIncrementCents: lot.increment * 100,
        startTime: start,
        endTime: end,
        status: lot.status,
        currentHighestBidAmountCents: highest,
        currentHighestBidderId: highestBidder,
        createdAt,
      },
    });
    lotIds.set(lot.key, created.id);
    ends.set(lot.key, end);
    if (highestBidder) winners.set(lot.key, highestBidder);

    amounts.forEach((amount, i) => {
      bidRows.push({
        lotId: created.id,
        buyerId: id(bidders[i]!),
        amountCents: amount,
        status: i === amounts.length - 1 ? 'WINNING' : 'OUTBID',
        createdAt: new Date(times[i]!),
      });
    });

    // Page views: more for popular lots, leaning toward the last few days.
    if (lot.status !== 'DRAFT') {
      const viewsTo = Math.min(end.getTime(), now);
      const total = Math.round(lot.bids * between(6, 11) + between(18, 70));
      for (let v = 0; v < total; v++) {
        const u = rand();
        viewRows.push({
          lotId: created.id,
          createdAt: new Date(start.getTime() + (viewsTo - start.getTime()) * (1 - (1 - u) ** 2.6)),
        });
      }
      await prisma.$executeRaw`UPDATE "Lot" SET "viewCount" = ${total} WHERE id = ${created.id}`;
    }

    if (lot.status === 'SOLD') {
      auditRows.push({
        action: 'LOT_SOLD',
        entityType: 'Lot',
        entityId: created.id,
        metadata: { winnerId: highestBidder, amountCents: highest },
        createdAt: end,
      });
    } else if (lot.status === 'UNSOLD') {
      auditRows.push({ action: 'LOT_UNSOLD', entityType: 'Lot', entityId: created.id, metadata: { reason: 'no bids' }, createdAt: end });
    }
  }

  for (let i = 0; i < bidRows.length; i += 1000) await prisma.bid.createMany({ data: bidRows.slice(i, i + 1000) });
  for (let i = 0; i < viewRows.length; i += 1000) await prisma.lotView.createMany({ data: viewRows.slice(i, i + 1000) });

  // Winners of sold lots paid the balance (winning bid minus the deposit) through Stripe.
  for (const lot of LOTS.filter((l) => l.status === 'SOLD')) {
    const lotId = lotIds.get(lot.key)!;
    const end = ends.get(lot.key)!;
    const winnerId = winners.get(lot.key)!;
    const top = await prisma.bid.findFirst({ where: { lotId, status: 'WINNING' } });
    if (!top) continue;
    await prisma.payment.create({
      data: {
        lotId,
        buyerId: winnerId,
        amountCents: top.amountCents - Math.round(lot.startingPrice * 100 * (DEPOSIT_PERCENT / 100)),
        status: 'SUCCEEDED',
        dueAt: new Date(end.getTime() + 48 * HOUR),
        paidAt: new Date(end.getTime() + between(3, 30) * HOUR),
        createdAt: end,
      },
    });
  }

  // Reviews from the winning buyers.
  for (const review of REVIEWS) {
    const lot = LOTS.find((l) => l.key === review.lot);
    const lotId = lotIds.get(review.lot);
    if (!lot || !lotId) continue;
    await prisma.review.create({
      data: {
        lotId,
        sellerId: id(lot.seller),
        authorId: winners.get(review.lot)!,
        rating: review.rating,
        title: review.title,
        comment: review.comment,
        createdAt: new Date(ends.get(review.lot)!.getTime() + review.afterDays * DAY),
      },
    });
  }

  // One resolved dispute and one waiting for an admin.
  const admin = id('admin');
  const lumberId = lotIds.get('df-lumber-bundles')!;
  const lumberEnd = ends.get('df-lumber-bundles')!;
  const resolved = await prisma.dispute.create({
    data: {
      lotId: lumberId,
      raisedById: id('granite'),
      reason: 'Item not as described',
      description:
        'One of the twelve bundles had water damage on the outer boards that was not visible in the listing photos.',
      status: 'RESOLVED',
      resolutionNote: 'Seller issued a partial credit for the damaged bundle; buyer confirmed receipt.',
      resolvedById: admin,
      createdAt: new Date(lumberEnd.getTime() + 2 * DAY),
      resolvedAt: new Date(lumberEnd.getTime() + 5 * DAY),
    },
  });
  auditRows.push({
    actorId: admin,
    action: 'RESOLVE_DISPUTE',
    entityType: 'Dispute',
    entityId: resolved.id,
    metadata: { status: 'RESOLVED', resolutionNote: resolved.resolutionNote },
    createdAt: resolved.resolvedAt ?? new Date(now),
  });
  await prisma.dispute.create({
    data: {
      lotId: lotIds.get('ups-rack-lot')!,
      raisedById: id('orion'),
      reason: 'Item not as described',
      description:
        'Two of the eight UPS units fail the self-test with a battery fault, although the listing says the batteries were replaced 14 months ago.',
      status: 'OPEN',
      createdAt: new Date(ends.get('ups-rack-lot')!.getTime() + 4 * DAY),
    },
  });

  // Verification decisions for every verified business.
  for (const u of USERS.filter((x) => x.role !== 'ADMIN' && x.verificationStatus === 'VERIFIED')) {
    auditRows.push({
      actorId: admin,
      action: 'VERIFY_USER',
      entityType: 'User',
      entityId: id(u.key),
      metadata: { verificationStatus: 'VERIFIED' },
      createdAt: new Date(now - u.joinedDaysAgo * DAY + between(6, 40) * HOUR),
    });
  }
  await prisma.auditLog.createMany({ data: auditRows });

  await prisma.contactMessage.createMany({
    data: MESSAGES.map(({ hoursAgo, ...m }) => ({ ...m, createdAt: new Date(now - hoursAgo * HOUR) })),
  });
  await prisma.newsletterSubscriber.createMany({
    data: SUBSCRIBERS.map((email, i) => ({ email, createdAt: new Date(now - (i * 9 + 3) * DAY) })),
    skipDuplicates: true,
  });

  return { lots: lotIds.size, bids: bidRows.length, views: viewRows.length };
}

async function main() {
  const now = Date.now();
  if (process.env.SEED_RESET === 'true') {
    await wipe();
    console.log('Database wiped.');
  }
  const users = await seedAccounts(now);
  const categories = await seedCategories();

  const existingLots = await prisma.lot.count();
  if (existingLots > 0) {
    console.log(
      `Accounts and categories are up to date. ${existingLots} lots already exist, so the demo catalogue was not loaded (run with SEED_RESET=true to start over).`
    );
    return;
  }
  const result = await seedCatalogue(users, categories, now);
  console.log(`Seeded ${result.lots} lots, ${result.bids} bids and ${result.views} page views.`);
  console.log(`Demo logins (password ${DEMO_PASSWORD} on a fresh database): admin@, seller@ and buyer@surplusbid.com`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
