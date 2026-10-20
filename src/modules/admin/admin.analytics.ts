import { prisma } from '../../config/prisma';

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** Last `days` UTC calendar days, oldest first, as YYYY-MM-DD. */
export function lastDays(days: number, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => dayKey(new Date(today - (days - 1 - i) * DAY_MS)));
}

/** Last `months` UTC calendar months, oldest first, as YYYY-MM. */
export function lastMonths(months: number, now = new Date()) {
  return Array.from({ length: months }, (_, i) =>
    monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1)))
  );
}

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

export async function bidsPerDay(days = 30) {
  const rows = await prisma.$queryRaw<{ day: Date; bids: bigint; volume: bigint; bidders: bigint }[]>`
    SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS bids,
           COALESCE(SUM("amountCents"), 0) AS volume, COUNT(DISTINCT "buyerId") AS bidders
    FROM "Bid"
    WHERE "createdAt" >= date_trunc('day', NOW()) - make_interval(days => ${days - 1}::int)
    GROUP BY 1`;
  const byDay = new Map(rows.map((r) => [dayKey(r.day), r]));
  return lastDays(days).map((day) => {
    const r = byDay.get(day);
    return { day, bids: num(r?.bids), volumeCents: num(r?.volume), bidders: num(r?.bidders) };
  });
}

/** Gross merchandise value: winning bids of lots that closed SOLD, by closing month. */
export async function gmvPerMonth(months = 6) {
  const rows = await prisma.$queryRaw<{ month: Date; gmv: bigint; lots: bigint }[]>`
    SELECT date_trunc('month', "endTime") AS month,
           COALESCE(SUM("currentHighestBidAmountCents"), 0) AS gmv, COUNT(*) AS lots
    FROM "Lot"
    WHERE status = 'SOLD' AND "deletedAt" IS NULL
      AND "endTime" >= date_trunc('month', NOW()) - make_interval(months => ${months - 1}::int)
    GROUP BY 1`;
  const byMonth = new Map(rows.map((r) => [monthKey(r.month), r]));
  return lastMonths(months).map((month) => {
    const r = byMonth.get(month);
    return { month, gmvCents: num(r?.gmv), lotsSold: num(r?.lots) };
  });
}

export async function signupsPerMonth(months = 6) {
  const rows = await prisma.$queryRaw<{ month: Date; role: string; count: bigint }[]>`
    SELECT date_trunc('month', "createdAt") AS month, role::text AS role, COUNT(*) AS count
    FROM "User"
    WHERE "deletedAt" IS NULL AND role <> 'ADMIN'
      AND "createdAt" >= date_trunc('month', NOW()) - make_interval(months => ${months - 1}::int)
    GROUP BY 1, 2`;
  return lastMonths(months).map((month) => {
    const inMonth = rows.filter((r) => monthKey(r.month) === month);
    const count = (role: string) => num(inMonth.find((r) => r.role === role)?.count);
    return { month, buyers: count('BUYER'), sellers: count('SELLER') };
  });
}

export async function categoryPerformance() {
  const rows = await prisma.$queryRaw<{ id: string; name: string; live: bigint; sold: bigint; unsold: bigint; gmv: bigint }[]>`
    SELECT c.id, c.name,
           COUNT(l.id) FILTER (WHERE l.status = 'LIVE') AS live,
           COUNT(l.id) FILTER (WHERE l.status = 'SOLD') AS sold,
           COUNT(l.id) FILTER (WHERE l.status = 'UNSOLD') AS unsold,
           COALESCE(SUM(l."currentHighestBidAmountCents") FILTER (WHERE l.status = 'SOLD'), 0) AS gmv
    FROM "Category" c
    LEFT JOIN "Lot" l ON l."categoryId" = c.id AND l."deletedAt" IS NULL
    GROUP BY c.id, c.name
    ORDER BY gmv DESC, c.name`;
  return rows.map((r) => {
    const closed = num(r.sold) + num(r.unsold);
    return {
      categoryId: r.id,
      name: r.name,
      liveLots: num(r.live),
      soldLots: num(r.sold),
      gmvCents: num(r.gmv),
      sellThroughRate: closed ? Math.round((num(r.sold) / closed) * 100) : null,
    };
  });
}

export async function lotsByStatus() {
  const rows = await prisma.lot.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } });
  return rows.map((r) => ({ status: r.status, count: r._count._all }));
}

export async function topBidders(days = 30, limit = 5) {
  const rows = await prisma.$queryRaw<{ id: string; companyName: string; bids: bigint; lots: bigint; volume: bigint }[]>`
    SELECT u.id, u."companyName", COUNT(b.id) AS bids, COUNT(DISTINCT b."lotId") AS lots,
           COALESCE(SUM(b."amountCents"), 0) AS volume
    FROM "Bid" b JOIN "User" u ON u.id = b."buyerId"
    WHERE b."createdAt" >= NOW() - make_interval(days => ${days}::int)
    GROUP BY u.id, u."companyName"
    ORDER BY bids DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    buyerId: r.id,
    companyName: r.companyName,
    bids: num(r.bids),
    lots: num(r.lots),
    volumeCents: num(r.volume),
  }));
}

export async function getAnalytics() {
  const [bids, gmv, signups, categories, statuses, bidders] = await Promise.all([
    bidsPerDay(30),
    gmvPerMonth(6),
    signupsPerMonth(6),
    categoryPerformance(),
    lotsByStatus(),
    topBidders(30, 5),
  ]);
  return { bidsPerDay: bids, gmvPerMonth: gmv, signupsPerMonth: signups, categories, lotsByStatus: statuses, topBidders: bidders };
}
