import { z } from 'zod';

export const placeBidSchema = z.object({
  amountCents: z.number().int().positive(),
});
