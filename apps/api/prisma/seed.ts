/**
 * Dev seed.
 *
 * Creates two tenants with users and a sample Web App Dev decision-tree
 * template per tenant, so you can hit the admin UI and immediately see
 * something. Seed is idempotent — re-running is safe (upsert everywhere).
 *
 * This is the only script allowed to touch Prisma without a tenant scope:
 * it has to create the tenants themselves. Run as DATABASE_URL (superuser).
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// Fixed UUIDs keep seed output reproducible across runs.
const TENANT_EVERLANE = '00000000-0000-0000-0000-000000000001';
const TENANT_ACME = '00000000-0000-0000-0000-000000000002';
const TEMPLATE_EVERLANE = '10000000-0000-0000-0000-000000000001';
const TEMPLATE_ACME = '10000000-0000-0000-0000-000000000002';

// Sample tree node ids (stable across runs so nextRules references work).
const N = {
  platform: '20000000-0000-0000-0000-000000000001',
  stack: '20000000-0000-0000-0000-000000000002',
  users: '20000000-0000-0000-0000-000000000003',
  timeline: '20000000-0000-0000-0000-000000000004',
  constraints: '20000000-0000-0000-0000-000000000005',
  attachments: '20000000-0000-0000-0000-000000000006',
};

const A = {
  platform: '30000000-0000-0000-0000-000000000001',
  stack: '30000000-0000-0000-0000-000000000002',
  users: '30000000-0000-0000-0000-000000000003',
  timeline: '30000000-0000-0000-0000-000000000004',
  constraints: '30000000-0000-0000-0000-000000000005',
  attachments: '30000000-0000-0000-0000-000000000006',
};

async function seedUsers(tenantId: string): Promise<void> {
  const passwordHash = await argon2.hash('password-dev-only-12');
  const users =
    tenantId === TENANT_EVERLANE
      ? [
          { email: 'admin@everlane.test', role: 'admin' },
          { email: 'maya@everlane.test', role: 'sales_employee' },
          { email: 'oren@everlane.test', role: 'sales_manager' },
        ]
      : [
          { email: 'admin@acme.test', role: 'admin' },
          { email: 'sam@acme.test', role: 'sales_employee' },
        ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, tenantId, passwordHash },
    });
  }
}

async function seedWebAppTemplate(tenantId: string, templateId: string, nodeIds: typeof N): Promise<void> {
  await prisma.template.upsert({
    where: { id: templateId },
    update: {},
    create: {
      id: templateId,
      tenantId,
      serviceLine: 'Web App Dev',
      name: 'Web App — greenfield scoping',
      version: 1,
      status: 'published',
    },
  });

  const nodes: Array<{
    id: string;
    question: string;
    nodeType: string;
    options?: Array<{ value: string; label: string; desc?: string }>;
    allowFiles?: boolean;
    nextRules: Array<{ when: { op: string; value?: unknown }; goto: string }>;
    position: number;
  }> = [
    {
      id: nodeIds.platform,
      question: 'Which platform are you building for?',
      nodeType: 'single_select',
      options: [
        { value: 'web', label: 'Web (SaaS)' },
        { value: 'mobile', label: 'Mobile (iOS/Android)' },
        { value: 'internal', label: 'Internal tool' },
      ],
      nextRules: [{ when: { op: 'always' }, goto: nodeIds.stack }],
      position: 0,
    },
    {
      id: nodeIds.stack,
      question: 'Any technologies already picked?',
      nodeType: 'multi_select',
      options: [
        { value: 'react', label: 'React / Next.js' },
        { value: 'vue', label: 'Vue / Nuxt' },
        { value: 'svelte', label: 'Svelte / SvelteKit' },
        { value: 'none', label: "Not sure yet" },
      ],
      allowFiles: true,
      nextRules: [{ when: { op: 'always' }, goto: nodeIds.users }],
      position: 1,
    },
    {
      id: nodeIds.users,
      question: 'How many users will the system serve?',
      nodeType: 'number',
      nextRules: [
        { when: { op: 'gt', value: 5000 }, goto: nodeIds.constraints },
        { when: { op: 'always' }, goto: nodeIds.timeline },
      ],
      position: 2,
    },
    {
      id: nodeIds.timeline,
      question: 'When do you need it delivered?',
      nodeType: 'single_select',
      options: [
        { value: 'urgent', label: 'Within 6 weeks', desc: 'Expedited pricing applies' },
        { value: 'standard', label: 'This quarter' },
        { value: 'flexible', label: 'No hard deadline' },
      ],
      nextRules: [{ when: { op: 'always' }, goto: nodeIds.constraints }],
      position: 3,
    },
    {
      id: nodeIds.constraints,
      question: 'Any must-have constraints? (compliance, residency, budget)',
      nodeType: 'long_text',
      nextRules: [{ when: { op: 'always' }, goto: nodeIds.attachments }],
      position: 4,
    },
    {
      id: nodeIds.attachments,
      question: 'Anything to share? (RFPs, diagrams, data samples)',
      nodeType: 'file_upload',
      allowFiles: true,
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      position: 5,
    },
  ];

  for (const n of nodes) {
    const optsField = n.options ? { options: n.options as unknown as object } : {};
    await prisma.templateNode.upsert({
      where: { id: n.id },
      update: {
        question: n.question,
        nodeType: n.nodeType,
        allowFiles: n.allowFiles ?? false,
        nextRules: n.nextRules as unknown as object,
        position: n.position,
        ...optsField,
      },
      create: {
        id: n.id,
        templateId,
        tenantId,
        question: n.question,
        nodeType: n.nodeType,
        allowFiles: n.allowFiles ?? false,
        nextRules: n.nextRules as unknown as object,
        position: n.position,
        ...optsField,
      },
    });
  }

  // Set root after nodes are created.
  await prisma.template.update({
    where: { id: templateId },
    data: { rootNodeId: nodeIds.platform },
  });
}

async function main(): Promise<void> {
  // Production guard. The seed creates demo tenants/users with hardcoded
  // passwords (`password-dev-only-12`) — that's fine for local dev but
  // strictly out of place in prod. Future deploys that accidentally run
  // `pnpm seed` would otherwise re-create the demo accounts even after
  // an admin deleted them. Set RHUD_ALLOW_PROD_SEED=1 to override (for
  // the very first prod boot, or a deliberate reset).
  if (process.env.NODE_ENV === 'production' && !process.env.RHUD_ALLOW_PROD_SEED) {
    console.error(
      'REFUSING to run dev seed in NODE_ENV=production.\n' +
      '  Set RHUD_ALLOW_PROD_SEED=1 to override (use only for the initial\n' +
      '  prod bring-up or a deliberate reset).',
    );
    process.exit(1);
  }

  await prisma.tenant.upsert({
    where: { id: TENANT_EVERLANE },
    update: {},
    create: { id: TENANT_EVERLANE, name: 'Everlane Consulting' },
  });
  await prisma.tenant.upsert({
    where: { id: TENANT_ACME },
    update: {},
    create: { id: TENANT_ACME, name: 'Acme Advisors' },
  });

  await seedUsers(TENANT_EVERLANE);
  await seedUsers(TENANT_ACME);

  await seedWebAppTemplate(TENANT_EVERLANE, TEMPLATE_EVERLANE, N);
  await seedWebAppTemplate(TENANT_ACME, TEMPLATE_ACME, A);

  console.log('Seed OK');
  console.log('  dev password for all users: password-dev-only-12');
  console.log(`  templates: Everlane=${TEMPLATE_EVERLANE}  Acme=${TEMPLATE_ACME}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
