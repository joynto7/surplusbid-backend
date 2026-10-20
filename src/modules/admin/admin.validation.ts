import { z } from 'zod';

export const verifyUserSchema = z.object({
  verificationStatus: z.enum(['VERIFIED', 'REJECTED']),
});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(10),
  q: z.string().trim().max(100).optional(),
});

export const usersQuerySchema = listQuerySchema.extend({
  verificationStatus: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']).optional(),
  role: z.enum(['BUYER', 'SELLER', 'ADMIN']).optional(),
});

export const messagesQuerySchema = listQuerySchema.extend({
  status: z.enum(['NEW', 'READ', 'ARCHIVED']).optional(),
});

export const messageStatusSchema = z.object({
  status: z.enum(['NEW', 'READ', 'ARCHIVED']),
});
