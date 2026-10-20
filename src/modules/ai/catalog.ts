import { prisma } from '../../config/prisma';

export interface CategoryInfo {
  id: string;
  name: string;
  slug: string;
}

/**
 * Words that point at a category, keyed by category slug. Used to read
 * natural-language searches ("forklift under 15k") and to suggest categories.
 */
export const CATEGORY_SYNONYMS: Record<string, string[]> = {
  machinery: [
    'cnc', 'lathe', 'mill', 'milling', 'press', 'compressor', 'generator', 'welder', 'welding', 'machine',
    'machining', 'grinder', 'saw', 'drill press', 'injection molding', 'plasma', 'laser cutter', 'boiler', 'pump',
  ],
  electronics: [
    'server', 'servers', 'laptop', 'laptops', 'computer', 'computers', 'monitor', 'monitors', 'switch', 'switches',
    'networking', 'network', 'ups', 'printer', 'tablet', 'ipad', 'macbook', 'thinkpad', 'poweredge', 'cisco',
    'storage', 'nas', 'rack', 'it equipment', 'electronics',
  ],
  vehicles: [
    'forklift', 'forklifts', 'truck', 'trucks', 'box truck', 'van', 'vans', 'trailer', 'vehicle', 'vehicles',
    'car', 'cars', 'pickup', 'golf cart', 'loader', 'tractor', 'fleet', 'bus',
  ],
  furniture: [
    'desk', 'desks', 'chair', 'chairs', 'table', 'tables', 'cubicle', 'cubicles', 'workstation', 'workstations',
    'cabinet', 'cabinets', 'sofa', 'office furniture', 'furniture', 'conference table', 'herman miller', 'steelcase',
  ],
  'raw-materials': [
    'steel', 'aluminum', 'aluminium', 'copper', 'brass', 'lumber', 'timber', 'plywood', 'plastic', 'resin',
    'coil', 'sheet metal', 'pipe', 'tubing', 'wire', 'cable reel', 'raw material', 'raw materials', 'stainless',
  ],
  'medical-lab': [
    'microscope', 'centrifuge', 'lab', 'laboratory', 'medical', 'hospital', 'hospital bed', 'ultrasound', 'autoclave',
    'incubator', 'fume hood', 'spectrometer', 'dental', 'patient monitor',
  ],
  'restaurant-equipment': [
    'oven', 'ovens', 'fryer', 'refrigerator', 'fridge', 'freezer', 'walk-in', 'mixer', 'kitchen', 'restaurant',
    'espresso', 'dishwasher', 'griddle', 'range', 'ice machine', 'commercial kitchen', 'hood',
  ],
  'warehouse-logistics': [
    'pallet racking', 'racking', 'rack shelving', 'shelving', 'conveyor', 'pallet jack', 'pallet jacks', 'scissor lift',
    'dock leveler', 'warehouse', 'logistics', 'mezzanine', 'stretch wrapper', 'pallet', 'pallets', 'tote',
  ],
};

let cache: { at: number; categories: CategoryInfo[]; locations: string[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Categories and known pickup locations, refreshed every few minutes. */
export async function catalogSnapshot() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const [categories, locationRows] = await Promise.all([
    prisma.category.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
    prisma.lot.findMany({
      where: { deletedAt: null, status: { not: 'DRAFT' }, location: { not: '' } },
      select: { location: true },
      distinct: ['location'],
      take: 500,
    }),
  ]);
  cache = { at: Date.now(), categories, locations: locationRows.map((l) => l.location) };
  return cache;
}

/** For tests: forget the cached snapshot. */
export function resetCatalogCache() {
  cache = null;
}
