import { prisma } from '../../config/prisma';

export function listCategories() {
  return prisma.category.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } });
}

export function createCategory(name: string) {
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
  return prisma.category.create({ data: { name, slug } });
}
