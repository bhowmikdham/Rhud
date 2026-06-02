/**
 * Dev convenience: attach a Prediction row to a couple of seeded opportunities
 * so the ApprovalCard / PriceSummary / ApprovalActions surface actually renders
 * (the detail page only mounts it when predictions.latest() returns a row).
 * Lets you visually walk the status×role matrix after the Phase C split.
 *
 * Run: pnpm --filter @rhud/api exec dotenv -e ../../.env -- tsx prisma/seed-predictions.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const TENANT = '00000000-0000-0000-0000-000000000001';
const inr = (rupees: number) => BigInt(Math.round(rupees * 100));

const DRIVERS = [
  { feature: 'repeat_client', label: 'Repeat client (loyalty)', weight: -0.04, direction: 'discount' },
  { feature: 'timeline', label: 'Tight delivery timeline', weight: 0.092, direction: 'premium' },
  { feature: 'api_surface', label: 'High API surface count', weight: 0.084, direction: 'premium' },
];

type Seed = {
  predId: string;
  engId: string;
  base: number;
  predicted: number;
  bandLow: number;
  bandHigh: number;
};

const SEEDS: Seed[] = [
  // Initech — status 'predicted' (manager can approve; rep sees read-only)
  { predId: '30000000-0000-0000-0000-000000000003', engId: '20000000-0000-0000-0000-000000000003',
    base: 1_620_000, predicted: 1_840_000, bandLow: 1_620_000, bandHigh: 2_010_000 },
  // Hooli — status 'approved' (shows approved chip + admin revert)
  { predId: '30000000-0000-0000-0000-000000000005', engId: '20000000-0000-0000-0000-000000000005',
    base: 2_900_000, predicted: 3_200_000, bandLow: 2_900_000, bandHigh: 3_500_000 },
];

async function main(): Promise<void> {
  for (const s of SEEDS) {
    const adjustmentPct = new Prisma.Decimal((s.predicted / s.base - 1).toFixed(4));
    const data = {
      tenantId: TENANT,
      engagementId: s.engId,
      regime: 'boosted',
      basePriceCents: inr(s.base),
      predictedPriceCents: inr(s.predicted),
      adjustmentPct,
      bandLowCents: inr(s.bandLow),
      bandHighCents: inr(s.bandHigh),
      drivers: DRIVERS as unknown as Prisma.InputJsonValue,
      similarPast: [] as unknown as Prisma.InputJsonValue,
      dataQuality: { closedUsed: 142 } as unknown as Prisma.InputJsonValue,
    };
    await prisma.prediction.upsert({
      where: { id: s.predId },
      update: data,
      create: { id: s.predId, ...data },
    });
    console.log(`  ✓ prediction for ${s.engId.slice(0, 13)} → ₹${s.predicted.toLocaleString('en-IN')}`);
  }
  console.log('\nSeeded predictions. The ApprovalCard now renders on those opportunities.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
