const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Passw0rd!', 10);

  await prisma.user.upsert({
    where: { email: 'admin@surplusbid.com' },
    update: {},
    create: {
      email: 'admin@surplusbid.com',
      passwordHash,
      role: 'ADMIN',
      companyName: 'SurplusBid HQ',
      verificationStatus: 'VERIFIED',
    },
  });

  await prisma.user.upsert({
    where: { email: 'seller@surplusbid.com' },
    update: {},
    create: {
      email: 'seller@surplusbid.com',
      passwordHash,
      role: 'SELLER',
      companyName: 'Acme Surplus Co',
      verificationStatus: 'VERIFIED',
    },
  });

  await prisma.user.upsert({
    where: { email: 'buyer@surplusbid.com' },
    update: {},
    create: {
      email: 'buyer@surplusbid.com',
      passwordHash,
      role: 'BUYER',
      companyName: 'Contoso Industrial',
      verificationStatus: 'VERIFIED',
    },
  });

  const categories = ['Machinery', 'Electronics', 'Vehicles', 'Furniture', 'Raw Materials'];
  for (const name of categories) {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    await prisma.category.upsert({ where: { slug }, update: {}, create: { name, slug } });
  }

  // eslint-disable-next-line no-console
  console.log('Seed complete. Demo admin: admin@surplusbid.com / Passw0rd!');
}

main().finally(() => prisma.$disconnect());
