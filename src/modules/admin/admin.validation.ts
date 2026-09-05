import { z } from 'zod';

export const verifyUserSchema = z.object({
  verificationStatus: z.enum(['VERIFIED', 'REJECTED']),
});
