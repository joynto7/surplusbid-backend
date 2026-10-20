import { prisma } from '../../config/prisma';
import { redis } from '../../config/redis';
import { bidsPerDay, categoryPerformance, topBidders } from '../admin/admin.analytics';
import { AI_MODEL, type AiMode, FALLBACK_PARAMS, llm, logAiError } from './llm';

type Severity = 'positive' | 'info' | 'warning' | 'critical';

export interface Insight {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  metric?: string;
  action?: { label: string; href: string };
}

export interface Anomaly {
  id: string;
  kind: 'bid-volume' | 'bid-jump' | 'rapid-bidding' | 'stalled-lot' | 'overdue-payment';
  title: string;
  detail: string;
  severity: Severity;
  at?: string;
  href?: string;
}

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Mean and standard deviation, for z-scores. */
function stats(values: number[]) {
  const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1);
  return { mean, std: Math.sqrt(variance) };
}

async function gmvWindow(fromDaysAgo: number, toDaysAgo: number) {
  const now = Date.now();
  const agg = await prisma.lot.aggregate({
    where: {
      status: 'SOLD',
      deletedAt: null,
      endTime: { gte: new Date(now - fromDaysAgo * 86_400_000), lt: new Date(now - toDaysAgo * 86_400_000) },
    },
    _sum: { currentHighestBidAmountCents: true },
    _count: { _all: true },
  });
  return { gmv: agg._sum.currentHighestBidAmountCents ?? 0, lots: agg._count._all };
}

/** Everything the dashboard's AI panel shows, computed from live data. */
async function computeInsights() {
  const insights: Insight[] = [];
  const anomalies: Anomaly[] = [];

  // 1. GMV momentum: last 30 days against the 30 before.
  const [current, previous] = await Promise.all([gmvWindow(30, 0), gmvWindow(60, 30)]);
  if (current.gmv || previous.gmv) {
    const change = previous.gmv ? ((current.gmv - previous.gmv) / previous.gmv) * 100 : 100;
    insights.push({
      id: 'gmv-momentum',
      title: change >= 0 ? 'Sales are growing' : 'Sales slowed this month',
      detail: `${usd(current.gmv)} sold across ${current.lots} lots in the last 30 days, against ${usd(previous.gmv)} the 30 days before.`,
      severity: change >= 0 ? 'positive' : 'warning',
      metric: pct(change),
    });
  }

  // 2. Category leaders and laggards.
  const categories = await categoryPerformance();
  const leader = categories.find((c) => c.gmvCents > 0);
  if (leader) {
    insights.push({
      id: 'top-category',
      title: `${leader.name} leads sales`,
      detail: `${usd(leader.gmvCents)} from ${leader.soldLots} sold lots${leader.sellThroughRate !== null ? `, with ${leader.sellThroughRate}% of closed lots selling` : ''}. ${leader.liveLots} more are live now.`,
      severity: 'info',
      metric: usd(leader.gmvCents),
      action: { label: 'View lots', href: `/lots?categoryId=${leader.categoryId}` },
    });
  }
  const laggard = categories
    .filter((c) => c.sellThroughRate !== null)
    .sort((a, b) => (a.sellThroughRate ?? 100) - (b.sellThroughRate ?? 100))[0];
  if (laggard && laggard.sellThroughRate !== null && laggard.sellThroughRate < 50) {
    insights.push({
      id: 'weak-category',
      title: `${laggard.name} lots often go unsold`,
      detail: `Only ${laggard.sellThroughRate}% of closed ${laggard.name.toLowerCase()} lots found a buyer. Lower starting prices or longer auctions usually help.`,
      severity: 'warning',
      metric: `${laggard.sellThroughRate}%`,
    });
  }

  // 3. The most active buyer this month.
  const [bidder] = await topBidders(30, 1);
  if (bidder) {
    insights.push({
      id: 'top-bidder',
      title: 'Most active buyer',
      detail: `${bidder.companyName} placed ${bidder.bids} bids on ${bidder.lots} lots in the last 30 days.`,
      severity: 'info',
      metric: `${bidder.bids} bids`,
      action: { label: 'Open users', href: `/admin/users?q=${encodeURIComponent(bidder.companyName)}` },
    });
  }

  // 4. Bid volume anomalies: days far from the 30-day norm (z-score).
  const series = await bidsPerDay(30);
  const { mean, std } = stats(series.map((d) => d.bids));
  const flagged = series
    .map((d) => ({ ...d, z: std ? (d.bids - mean) / std : 0 }))
    .filter((d) => Math.abs(d.z) >= 2 && Math.abs(d.bids - mean) >= 3);
  for (const day of flagged.slice(-3)) {
    anomalies.push({
      id: `volume-${day.day}`,
      kind: 'bid-volume',
      title: day.z > 0 ? 'Unusual spike in bidding' : 'Unusual drop in bidding',
      detail: `${day.bids} bids on ${day.day}, against a typical ${mean.toFixed(1)} a day (z-score ${day.z.toFixed(1)}).`,
      severity: day.z > 0 ? 'info' : 'warning',
      at: day.day,
    });
  }

  // 5. Bid jumps: a bid at least 2.5× the previous one on the same lot (fat finger, or price manipulation).
  const jumps = await prisma.$queryRaw<{ id: string; lotId: string; title: string; amount: number; previous: number; createdAt: Date }[]>`
    SELECT b.id, b."lotId", l.title, b."amountCents" AS amount, b.prev AS previous, b."createdAt"
    FROM (
      SELECT id, "lotId", "amountCents", "createdAt",
             LAG("amountCents") OVER (PARTITION BY "lotId" ORDER BY "createdAt") AS prev
      FROM "Bid"
    ) b JOIN "Lot" l ON l.id = b."lotId"
    WHERE b.prev IS NOT NULL AND b."amountCents" >= b.prev * 2.5 AND b."createdAt" >= NOW() - interval '30 days'
    ORDER BY b."createdAt" DESC
    LIMIT 3`;
  for (const j of jumps) {
    anomalies.push({
      id: `jump-${j.id}`,
      kind: 'bid-jump',
      title: 'Bid jump worth a look',
      detail: `A ${usd(num(j.amount))} bid followed ${usd(num(j.previous))} on “${j.title}”, ${(num(j.amount) / num(j.previous)).toFixed(1)}× the previous bid.`,
      severity: 'warning',
      at: j.createdAt.toISOString(),
      href: `/lots/${j.lotId}`,
    });
  }

  // 6. Rapid-fire bidding: one buyer placing 6+ bids on one lot within 10 minutes.
  const bursts = await prisma.$queryRaw<{ buyerId: string; companyName: string; lotId: string; title: string; bids: bigint }[]>`
    SELECT b."buyerId", u."companyName", b."lotId", l.title, COUNT(*) AS bids
    FROM "Bid" b
    JOIN "User" u ON u.id = b."buyerId"
    JOIN "Lot" l ON l.id = b."lotId"
    WHERE b."createdAt" >= NOW() - interval '7 days'
      AND EXISTS (
        SELECT 1 FROM "Bid" b2
        WHERE b2."buyerId" = b."buyerId" AND b2."lotId" = b."lotId"
          AND b2."createdAt" BETWEEN b."createdAt" - interval '10 minutes' AND b."createdAt"
        GROUP BY b2."buyerId" HAVING COUNT(*) >= 6
      )
    GROUP BY b."buyerId", u."companyName", b."lotId", l.title
    LIMIT 3`;
  for (const b of bursts) {
    anomalies.push({
      id: `burst-${b.buyerId}-${b.lotId}`,
      kind: 'rapid-bidding',
      title: 'Rapid-fire bidding',
      detail: `${b.companyName} placed ${num(b.bids)} bids on “${b.title}” this week, at least 6 of them within 10 minutes. Worth checking for automation.`,
      severity: 'warning',
      href: `/lots/${b.lotId}`,
    });
  }

  // 7. Lots with plenty of views but no bids: probably priced too high.
  const stalled = await prisma.lot.findMany({
    where: { status: 'LIVE', deletedAt: null, viewCount: { gte: 25 }, bids: { none: {} } },
    select: { id: true, title: true, viewCount: true, startingPriceCents: true },
    orderBy: { viewCount: 'desc' },
    take: 2,
  });
  for (const lot of stalled) {
    anomalies.push({
      id: `stalled-${lot.id}`,
      kind: 'stalled-lot',
      title: 'High interest, no bids',
      detail: `“${lot.title}” has ${lot.viewCount} views and no bids at a ${usd(lot.startingPriceCents)} start. Its starting price may be too high.`,
      severity: 'info',
      href: `/lots/${lot.id}`,
    });
  }

  // 8. Operational backlog.
  const [overdue, pendingVerifications, openDisputes, newMessages] = await Promise.all([
    prisma.payment.count({ where: { status: 'PENDING', dueAt: { lt: new Date() } } }),
    prisma.user.count({ where: { verificationStatus: 'PENDING', deletedAt: null } }),
    prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
    prisma.contactMessage.count({ where: { status: 'NEW' } }),
  ]);
  if (overdue) {
    anomalies.push({
      id: 'overdue-payments',
      kind: 'overdue-payment',
      title: 'Overdue payments',
      detail: `${overdue} winning ${overdue === 1 ? 'buyer has' : 'buyers have'} missed the payment deadline. The settlement job rolls those lots to the next bidder.`,
      severity: 'critical',
    });
  }
  if (pendingVerifications) {
    insights.push({
      id: 'verification-backlog',
      title: 'Businesses waiting for verification',
      detail: `${pendingVerifications} ${pendingVerifications === 1 ? 'business is' : 'businesses are'} waiting for review. Verified buyers bid sooner.`,
      severity: pendingVerifications > 3 ? 'warning' : 'info',
      metric: String(pendingVerifications),
      action: { label: 'Review queue', href: '/admin/verifications' },
    });
  }
  if (openDisputes) {
    insights.push({
      id: 'open-disputes',
      title: 'Open disputes',
      detail: `${openDisputes} ${openDisputes === 1 ? 'dispute needs' : 'disputes need'} a decision.`,
      severity: 'warning',
      metric: String(openDisputes),
      action: { label: 'Review disputes', href: '/admin/disputes' },
    });
  }
  if (newMessages) {
    insights.push({
      id: 'new-messages',
      title: 'Unread contact messages',
      detail: `${newMessages} ${newMessages === 1 ? 'message is' : 'messages are'} waiting in the inbox.`,
      severity: 'info',
      metric: String(newMessages),
      action: { label: 'Open inbox', href: '/admin/messages' },
    });
  }

  return { insights, anomalies, bidSeries: series.map((d) => ({ ...d, anomaly: flagged.some((f) => f.day === d.day) })) };
}

function templateSummary(insights: Insight[], anomalies: Anomaly[]) {
  const lead = insights.find((i) => i.id === 'gmv-momentum');
  const cat = insights.find((i) => i.id === 'top-category');
  const parts = [
    lead ? `${lead.title} (${lead.metric} over the previous 30 days).` : 'Marketplace activity is steady.',
    cat ? `${cat.title}.` : '',
    anomalies.length
      ? `${anomalies.length} item${anomalies.length === 1 ? ' needs' : 's need'} review, starting with “${anomalies[0]!.title.toLowerCase()}”.`
      : 'No unusual activity detected.',
  ];
  return parts.filter(Boolean).join(' ');
}

const CACHE_KEY = 'ai:admin-insights';
const CACHE_TTL_S = 5 * 60;

export async function adminInsights() {
  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) return JSON.parse(cached) as Awaited<ReturnType<typeof buildInsights>>;
  const result = await buildInsights();
  await redis.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_S).catch(() => undefined);
  return result;
}

async function buildInsights() {
  const { insights, anomalies, bidSeries } = await computeInsights();
  let summary = templateSummary(insights, anomalies);
  let summaryMode: AiMode = 'smart';

  if (llm && (insights.length || anomalies.length)) {
    try {
      const response = await llm.beta.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        ...FALLBACK_PARAMS,
        output_config: { effort: 'low' },
        system:
          'You brief the operations team of SurplusBid, a B2B surplus auction marketplace. Write a 2 to 3 sentence plain-text summary of the computed findings: lead with the most important change, then what needs attention. Use only the numbers given. No greeting, no markdown.',
        messages: [{ role: 'user', content: JSON.stringify({ insights, anomalies }) }],
      });
      const text = response.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join(' ')
        .trim();
      if (response.stop_reason !== 'refusal' && text) {
        summary = text;
        summaryMode = 'ai';
      }
    } catch (err) {
      logAiError('admin-insights', err);
    }
  }

  return { generatedAt: new Date().toISOString(), summary, summaryMode, insights, anomalies, bidSeries };
}
