import { z } from 'zod';

export const initiatePaymentSchema = z.object({
  paymentId: z.string().uuid(),
});
