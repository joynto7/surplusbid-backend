import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const updateProfileSchema = z.object({
  companyName: z.string().min(2).optional(),
  taxId: z.string().optional(),
  contactName: optionalText(80),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+\d][\d\s().-]*$/, 'Use digits, spaces and + ( ) - only')
    .or(z.literal(''))
    .optional(),
  location: optionalText(80),
  bio: optionalText(500),
});
