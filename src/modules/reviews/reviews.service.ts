import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { pageMeta } from '../../utils/pagination';
import { findLotById } from '../lots/lots.service';
import { ratingBreakdown } from './ratings';
import { createReviewSchema, reviewListQuerySchema } from './reviews.validation';

type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

const REVIEW_SELECT = {
  id: true, rating: true, title: true, comment: true, createdAt: true, lotId: true, sellerId: true, authorId: true,
  lot: { select: { id: true, title: true, images: true } },
  author: { select: { id: true, companyName: true, location: true } },
  seller: { select: { id: true, companyName: true } },
} satisfies Prisma.ReviewSelect;

function filters(query: Pick<ReviewListQuery, 'rating' | 'q'>): Prisma.ReviewWhereInput[] {
  const and: Prisma.ReviewWhereInput[] = [];
  if (query.rating) and.push({ rating: query.rating });
  if (query.q) {
    and.push({
      OR: [
        { title: { contains: query.q, mode: 'insensitive' } },
        { comment: { contains: query.q, mode: 'insensitive' } },
        { lot: { title: { contains: query.q, mode: 'insensitive' } } },
        { author: { companyName: { contains: query.q, mode: 'insensitive' } } },
        { seller: { companyName: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }
  return and;
}

async function listReviews(where: Prisma.ReviewWhereInput, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.review.findMany({
      where,
      select: REVIEW_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.review.count({ where }),
  ]);
  return { items, meta: pageMeta(page, limit, total) };
}

/** Only the buyer who won a sold lot can review its seller, once per lot. */
export async function createReview(authorId: string, data: z.infer<typeof createReviewSchema>) {
  const lot = await findLotById(data.lotId);
  if (lot.status !== 'SOLD') throw new ApiError(409, 'Reviews open once the auction is sold');
  if (lot.currentHighestBidderId !== authorId) throw new ApiError(403, 'Only the winning buyer can review this lot');

  const existing = await prisma.review.findUnique({ where: { lotId_authorId: { lotId: lot.id, authorId } } });
  if (existing) throw new ApiError(409, 'You have already reviewed this lot');

  return prisma.review.create({
    data: { ...data, sellerId: lot.sellerId, authorId },
    select: REVIEW_SELECT,
  });
}

export async function listSellerReviews(sellerId: string, query: ReviewListQuery) {
  const [list, summary] = await Promise.all([
    listReviews({ AND: [{ sellerId }, ...filters(query)] }, query.page, query.limit),
    ratingBreakdown(sellerId),
  ]);
  return { ...list, summary };
}

export function listMyReviews(authorId: string, query: ReviewListQuery) {
  return listReviews({ AND: [{ authorId }, ...filters(query)] }, query.page, query.limit);
}

/** Sold lots this buyer won and hasn't reviewed yet. */
export function listReviewableLots(buyerId: string) {
  return prisma.lot.findMany({
    where: {
      status: 'SOLD',
      deletedAt: null,
      currentHighestBidderId: buyerId,
      reviews: { none: { authorId: buyerId } },
    },
    select: {
      id: true, title: true, images: true, endTime: true, currentHighestBidAmountCents: true,
      seller: { select: { id: true, companyName: true } },
    },
    orderBy: { endTime: 'desc' },
    take: 20,
  });
}

/** Recent reviews for the home page; 4 and 5 stars only, newest first. */
export function latestReviews(limit: number) {
  return prisma.review.findMany({
    where: { rating: { gte: 4 } },
    select: REVIEW_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function listAllReviews(query: ReviewListQuery) {
  return listReviews({ AND: filters(query) }, query.page, query.limit);
}

export async function deleteReview(reviewId: string, adminId: string) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw new ApiError(404, 'Review not found');
  await prisma.$transaction([
    prisma.review.delete({ where: { id: reviewId } }),
    prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: 'DELETE_REVIEW',
        entityType: 'Review',
        entityId: reviewId,
        metadata: { lotId: review.lotId, sellerId: review.sellerId, rating: review.rating },
      },
    }),
  ]);
}
