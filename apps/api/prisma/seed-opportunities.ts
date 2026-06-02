/**
 * Dev convenience: seed a spread of sample opportunities for the Everlane
 * tenant so /opportunities (list + kanban) and the detail page have something
 * to show. Idempotent — deterministic IDs, upsert everywhere. Safe to re-run.
 *
 * Run: pnpm --filter @rhud/api exec dotenv -e ../../.env -- tsx prisma/seed-opportunities.ts
 *
 * Like seed.ts, this connects as DATABASE_URL (superuser) and writes across the
 * tenant boundary deliberately — it is a seeding script, not app code.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT = '00000000-0000-0000-0000-000000000001'; // Everlane
const TEMPLATE = '10000000-0000-0000-0000-000000000001'; // "Web App — greenfield scoping"
const TEMPLATE_VERSION = 1;
const MAYA = '8cd25c92-b5a2-4c10-87e3-c5b23d797c47'; // sales_employee
const OREN = '2ce819e1-3d65-49d3-a1e7-6c37504ca85c'; // sales_manager

const day = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * day);
// rupees → cents (the UI divides predicted_price_cents by 100)
const inr = (rupees: number) => BigInt(Math.round(rupees * 100));

type Sample = {
  n: number;
  name: string;
  clientEmail: string;
  clientName: string;
  status: string;
  createdDaysAgo: number;
  submittedDaysAgo?: number;
  predicted?: number;
  low?: number;
  high?: number;
  approved?: number;
  proposalDraft?: string;
  closedDaysAgo?: number;
};

const SAMPLES: Sample[] = [
  {
    n: 1, name: 'Northwind Storefront Rebuild', clientEmail: 'procurement@northwind.example',
    clientName: 'Northwind Traders', status: 'in_progress', createdDaysAgo: 6,
  },
  {
    n: 2, name: 'Globex Customer Portal', clientEmail: 'cto@globex.example',
    clientName: 'Globex Corporation', status: 'submitted', createdDaysAgo: 5, submittedDaysAgo: 3,
  },
  {
    n: 3, name: 'Initech Payments Integration', clientEmail: 'dev@initech.example',
    clientName: 'Initech', status: 'predicted', createdDaysAgo: 4, submittedDaysAgo: 2,
    predicted: 1_840_000, low: 1_620_000, high: 2_010_000,
  },
  {
    n: 4, name: 'Soylent Nutrition Dashboard', clientEmail: 'ops@soylent.example',
    clientName: 'Soylent Corp', status: 'pending_approval', createdDaysAgo: 4, submittedDaysAgo: 2,
    predicted: 960_000, low: 880_000, high: 1_050_000,
  },
  {
    n: 5, name: 'Hooli Search Revamp', clientEmail: 'pm@hooli.example',
    clientName: 'Hooli', status: 'approved', createdDaysAgo: 7, submittedDaysAgo: 4,
    predicted: 3_200_000, low: 2_900_000, high: 3_500_000, approved: 3_200_000,
  },
  {
    n: 6, name: 'Umbrella Health Booking', clientEmail: 'it@umbrella.example',
    clientName: 'Umbrella Corp', status: 'draft_ready', createdDaysAgo: 8, submittedDaysAgo: 5,
    predicted: 1_750_000, low: 1_600_000, high: 1_900_000, approved: 1_750_000,
    proposalDraft: 'Dear Umbrella Corp,\n\nThank you for the opportunity to scope your booking platform. Based on the requirements gathered, we propose a phased delivery...\n\n(Sample draft — seeded for preview.)',
  },
  {
    n: 7, name: 'Wayne Industries Security Portal', clientEmail: 'security@wayne.example',
    clientName: 'Wayne Industries', status: 'sent', createdDaysAgo: 10, submittedDaysAgo: 7,
    predicted: 2_200_000, low: 2_000_000, high: 2_450_000, approved: 2_200_000,
    proposalDraft: 'Dear Wayne Industries,\n\nPlease find our proposal for the secure client portal...\n\n(Sample draft — seeded for preview.)',
  },
  {
    n: 8, name: 'Stark Expo Microsite', clientEmail: 'events@stark.example',
    clientName: 'Stark Industries', status: 'rejected', createdDaysAgo: 9, submittedDaysAgo: 6,
    predicted: 540_000, low: 480_000, high: 600_000,
  },
];

function idFor(n: number): string {
  return `20000000-0000-0000-0000-0000000000${n.toString().padStart(2, '0')}`;
}

async function main(): Promise<void> {
  for (const s of SAMPLES) {
    const id = idFor(s.n);
    const data = {
      tenantId: TENANT,
      templateId: TEMPLATE,
      templateVersion: TEMPLATE_VERSION,
      source: 'manual_form',
      salesEmployeeId: MAYA,
      salesManagerId: OREN,
      clientEmail: s.clientEmail,
      clientName: s.clientName,
      name: s.name,
      status: s.status,
      createdAt: ago(s.createdDaysAgo),
      ...(s.submittedDaysAgo != null ? { submittedAt: ago(s.submittedDaysAgo) } : {}),
      ...(s.closedDaysAgo != null ? { closedAt: ago(s.closedDaysAgo) } : {}),
      ...(s.predicted != null ? { predictedPriceCents: inr(s.predicted) } : {}),
      ...(s.low != null ? { priceLowCents: inr(s.low) } : {}),
      ...(s.high != null ? { priceHighCents: inr(s.high) } : {}),
      ...(s.approved != null ? { approvedPriceCents: inr(s.approved) } : {}),
      ...(s.proposalDraft != null
        ? { proposalDraft: s.proposalDraft, proposalDraftSource: 'anthropic', proposalDraftedAt: ago(1) }
        : {}),
    };
    await prisma.engagement.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
    console.log(`  ✓ [${s.status.padEnd(16)}] ${s.name}`);
  }
  const total = await prisma.engagement.count({ where: { tenantId: TENANT } });
  console.log(`\nSeeded ${SAMPLES.length} sample opportunities. Everlane now has ${total} total.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
