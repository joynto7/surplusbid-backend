import { z } from 'zod';

const specSchema = z.object({
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(120),
});

// Multipart create requests send specs as a JSON string; JSON PATCH requests send an array.
const specsSchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.array(specSchema).max(12));

const lotBaseSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  categoryId: z.string().uuid(),
  condition: z.string().min(2),
  quantity: z.coerce.number().int().positive(),
  startingPriceCents: z.coerce.number().int().positive(),
  reservePriceCents: z.coerce.number().int().positive(),
  bidIncrementCents: z.coerce.number().int().positive(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  location: z.string().trim().max(80).optional(),
  specs: specsSchema.optional(),
});

// Zod v4 forbids .partial() on a refined schema, so the base object is
// refined for create and partial()'d (unrefined) for update.
export const createLotSchema = lotBaseSchema.refine((d) => new Date(d.endTime) > new Date(d.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

export const updateLotSchema = lotBaseSchema.partial().refine(
  (d) => !d.startTime || !d.endTime || new Date(d.endTime) > new Date(d.startTime),
  { message: 'endTime must be after startTime', path: ['endTime'] }
);
