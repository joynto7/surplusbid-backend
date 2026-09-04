import { z } from 'zod';

export const updateProfileSchema = z.object({
  companyName: z.string().min(2).optional(),
  taxId: z.string().optional(),
});
