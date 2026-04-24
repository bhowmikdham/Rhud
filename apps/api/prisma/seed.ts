/**
 * Dev seed: two tenants, each with an admin + a sales employee.
 *
 * This is the only script allowed to touch Prisma without a tenant scope:
 * it has to create the tenants themselves. Run as DATABASE_URL (superuser).
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const password = 'password-dev-only-12';
  const passwordHash = await argon2.hash(password);

  const everlane = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Everlane Consulting',
    },
  });

  const acme = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Acme Advisors',
    },
  });

  for (const [tenantId, users] of [
    [
      everlane.id,
      [
        { email: 'admin@everlane.test', role: 'admin' },
        { email: 'maya@everlane.test', role: 'sales_employee' },
        { email: 'oren@everlane.test', role: 'sales_manager' },
      ],
    ],
    [
      acme.id,
      [
        { email: 'admin@acme.test', role: 'admin' },
        { email: 'sam@acme.test', role: 'sales_employee' },
      ],
    ],
  ] as const) {
    for (const u of users) {
      await prisma.user.upsert({
        where: { email: u.email },
        update: {},
        create: { ...u, tenantId, passwordHash },
      });
    }
  }

  console.log('Seed OK');
  console.log(`  dev password for all users: ${password}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
