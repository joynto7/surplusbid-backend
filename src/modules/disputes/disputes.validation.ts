import { z } from 'zod';

export const createDisputeSchema = z.object({
  lotId: z.string().uuid(),
  reason: z.string().min(3),
  description: z.string().min(10),
});

export const resolveDisputeSchema = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  resolutionNote: z.string().min(3),
});
