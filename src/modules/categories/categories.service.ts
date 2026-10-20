import { prisma } from '../../config/prisma';

export async function listCategories() {
  const categories = await prisma.category.findMany({
    select: {
      id: true, name: true, slug: true, description: true, imageUrl: true,
      _count: { select: { lots: { where: { status: 'LIVE', deletedAt: null } } } },
    },
    orderBy: { name: 'asc' },
  });
  return categories.map(({ _count, ...c }) => ({ ...c, liveLotCount: _count.lots }));
}

export function createCategory(input: { name: string; description?: string | undefined; imageUrl?: string | undefined }) {
  const slug = input.name.toLowerCase().trim().replace(/\s+/g, '-');
  return prisma.category.create({
    data: {
      name: input.name,
      slug,
      ...(input.description ? { description: input.description } : {}),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    },
  });
}
