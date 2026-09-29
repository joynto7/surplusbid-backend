import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { redis } from '../../config/redis';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { findLotById } from '../lots/lots.service';

export async function getActiveHold(lotId: string, buyerId: string) {
  return prisma.depositHold.findFirst({ where: { lotId, buyerId, status: 'AUTHORIZED' } });
}

// Stripe statuses that mean the buyer's card really is authorized for the hold.
// A freshly created manual-capture intent sits in 'requires_payment_method'
// until the buyer confirms it client-side with the returned clientSecret.
const CONFIRMED_HOLD_STATUSES = new Set(['requires_capture', 'processing', 'succeeded']);
const AWAITING_CARD_STATUSES = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
const HOLD_CONFIRMED_TTL_S = 7 * 24 * 60 * 60;

/**
 * True once Stripe reports the hold's card authorization. Cached in Redis so
 * only the first bid per hold pays for the Stripe round-trip.
 */
export async function isHoldConfirmed(hold: { id: string; stripePaymentIntentId: string }) {
  const key = `hold:${hold.id}:confirmed`;
  if (await redis.get(key)) return true;
  const intent = await stripe.paymentIntents.retrieve(hold.stripePaymentIntentId);
  if (!CONFIRMED_HOLD_STATUSES.has(intent.status)) return false;
  await redis.set(key, '1', 'EX', HOLD_CONFIRMED_TTL_S);
  return true;
}

export async function createDepositHold(lotId: string, buyerId: string) {
  const lot = await findLotById(lotId);
  if (lot.status !== 'LIVE') throw new ApiError(409, 'This lot is not open for bidding');

  const existing = await prisma.depositHold.findUnique({ where: { lotId_buyerId: { lotId, buyerId } } });
  if (existing) {
    // The buyer started a hold but never confirmed the card (closed the dialog,
    // 3-D Secure abandoned…): hand back the same intent so they can finish it
    // instead of being locked out by the unique (lotId, buyerId) constraint.
    if (existing.status === 'AUTHORIZED') {
      const intent = await stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
      if (AWAITING_CARD_STATUSES.has(intent.status)) return { ...existing, clientSecret: intent.client_secret };
    }
    throw new ApiError(409, 'A deposit hold already exists for this lot');
  }

  const amountCents = Math.round(lot.startingPriceCents * (env.depositPercent / 100));
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    capture_method: 'manual',
    metadata: { lotId, buyerId },
  });

  const hold = await prisma.depositHold.create({
    data: { lotId, buyerId, amountCents, stripePaymentIntentId: intent.id, status: 'AUTHORIZED' },
  });
  // The client confirms the card authorization with this secret (Stripe Payment Element).
  return { ...hold, clientSecret: intent.client_secret };
}

const ANTI_SNIPE_WINDOW_MS = 2 * 60 * 1000;
const ANTI_SNIPE_EXTENSION_MS = 2 * 60 * 1000;

type LockedLot = {
  id: string;
  status: string;
  endTime: Date;
  startingPriceCents: number;
  currentHighestBidAmountCents: number | null;
  bidIncrementCents: number;
};

// A bid that cannot get the Lot row lock within LOCK_TIMEOUT_MS fails with
// Postgres 55P03 (lock_not_available), which errorHandler maps to a retryable 503.
// Without it, the lock wait silently eats the whole transaction budget and comes
// back as an opaque P2028 — the exact scenario anti-sniping manufactures, with a
// crowd of bidders queued on one hot lot in its closing seconds.
// TRANSACTION_TIMEOUT_MS is deliberately well clear of LOCK_TIMEOUT_MS so that a
// bid which waited nearly the full lock timeout still has budget left to commit.
const LOCK_TIMEOUT_MS = 3000;
const TRANSACTION_TIMEOUT_MS = 8000;

export async function placeBid(lotId: string, buyerId: string, amountCents: number) {
  const hold = await getActiveHold(lotId, buyerId);
  if (!hold) throw new ApiError(403, 'You must authorize a deposit hold before bidding on this lot');
  // Without this, an unconfirmed hold would let the buyer bid and later make
  // the deposit capture at checkout fail (Stripe can't capture an intent with no card).
  if (!(await isHoldConfirmed(hold))) {
    throw new ApiError(403, 'Confirm your card for the deposit hold before bidding on this lot');
  }

  return prisma.$transaction(
    async (tx) => {
      // Bounds the FOR UPDATE wait below. Takes no locks and reads nothing, so the
      // locked read below is still the first statement to touch contended state.
      // $executeRawUnsafe because SET does not accept bind parameters; the value is a
      // module constant, never caller input.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

      // FIRST statement in the transaction: take the row lock before reading anything
      // else, so a concurrent bid on this lot blocks here and then re-reads the
      // committed highest bid instead of racing against a stale copy.
      const rows = await tx.$queryRaw<LockedLot[]>`
        SELECT id, status, "endTime", "startingPriceCents", "currentHighestBidAmountCents", "bidIncrementCents"
        FROM "Lot" WHERE id = ${lotId} AND "deletedAt" IS NULL FOR UPDATE
      `;
      const lot = rows[0];
      if (!lot) throw new ApiError(404, 'Lot not found');
      if (lot.status !== 'LIVE') throw new ApiError(409, 'This lot is not open for bidding');
      if (lot.endTime.getTime() <= Date.now()) throw new ApiError(409, 'Bidding on this lot has closed');

      const currentPrice = lot.currentHighestBidAmountCents ?? lot.startingPriceCents;
      const minimumAcceptable = currentPrice + lot.bidIncrementCents;
      if (amountCents < minimumAcceptable) {
        throw new ApiError(409, `Bid must be at least ${minimumAcceptable} cents`);
      }

      await tx.bid.updateMany({ where: { lotId, status: 'WINNING' }, data: { status: 'OUTBID' } });
      const bid = await tx.bid.create({ data: { lotId, buyerId, amountCents, status: 'WINNING' } });

      const extendEndTime =
        lot.endTime.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS
          ? new Date(lot.endTime.getTime() + ANTI_SNIPE_EXTENSION_MS)
          : lot.endTime;

      await tx.lot.update({
        where: { id: lotId },
        data: {
          currentHighestBidAmountCents: amountCents,
          currentHighestBidderId: buyerId,
          endTime: extendEndTime,
        },
      });

      // Kept inside the lock on purpose: getLotDetail always prefers this key over
      // the DB column, so cache writes must land in the same order the bids commit.
      // ponytail: costs a Redis round-trip while the Lot row lock is held (a Redis
      // stall blocks all bidding on this lot until the tx timeout), and a failed
      // commit can leave the key one bid high. Move to a post-commit write keyed by
      // bid id, or drop the cache-preferred read in getLotDetail, if either bites.
      await redis.set(`lot:${lotId}:highestBid`, amountCents);
      return bid;
    },
    { isolationLevel: 'ReadCommitted', timeout: TRANSACTION_TIMEOUT_MS }
  );
}

export async function getBidHistory(lotId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.bid.findMany({
      where: { lotId },
      select: { id: true, amountCents: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bid.count({ where: { lotId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getMyBids(buyerId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.bid.findMany({
      where: { buyerId },
      select: { id: true, lotId: true, amountCents: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bid.count({ where: { buyerId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
