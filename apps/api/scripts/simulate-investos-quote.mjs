// Simulate the new mapper against the live Prophaze rate card with
// the actual signal we discovered for investos.world.
import { PrismaClient } from '@prisma/client';
import { computeBasePrice } from '@rhud/shared';

const p = new PrismaClient();
const ids = await p.$queryRaw`SELECT id FROM rate_cards WHERE id::text LIKE '5e98c7e7%'`;
const card = await p.rateCard.findUnique({
  where: { id: ids[0].id },
  include: {
    serviceLines: { include: { tiers: true }, orderBy: { position: 'asc' } },
    openPricedServices: { orderBy: { position: 'asc' } },
  },
});

// Hand-rolled — same shape the mapper produces.
const canonical = {
  id: card.id,
  tenantId: card.tenantId,
  name: card.name,
  version: card.version,
  status: card.status,
  currency: card.currency,
  inferenceContext: card.inferenceContext,
  defaultMethodologyRule: card.defaultMethodologyRule,
  inferenceExamples: Array.isArray(card.inferenceExamples) ? card.inferenceExamples : [],
  serviceLines: card.serviceLines.map((sl) => ({
    id: sl.id, slug: sl.slug, displayName: sl.displayName,
    scopeUnit: sl.scopeUnit, pricingModel: sl.pricingModel, position: sl.position,
    inferenceHint: sl.inferenceHint, inferenceExamples: Array.isArray(sl.inferenceExamples) ? sl.inferenceExamples : [],
    tiers: sl.tiers.map((t) => ({
      id: t.id, rangeMin: t.rangeMin, rangeMax: t.rangeMax,
      methodology: t.methodology, customerType: t.customerType,
      priceCents: Number(t.priceCents),
      displayLabel: t.displayLabel,
    })),
  })),
  openPricedServices: card.openPricedServices,
};

// Signals discovered for investos.world (from the live e2e):
const signals = {
  totalFormFields: 47,
  looksLikeSpa: true,
  customerType: 'external',
};

// Categories observed.
const summaries = [
  { category: 'cms', count: 8, examples: [] },
  { category: 'members', count: 1, examples: [] },
  { category: 'api', count: 49, examples: [] },
  { category: 'integration', count: 4, examples: [] },
];

// Inline the mapper logic (Node can't import the .ts sources directly).
const PREFERRED = {
  cms: ['vapt_web_app_static_pages', 'vapt_web_app_dynamic_pages'],
  members: ['vapt_web_app_login_modules'],
  api: ['vapt_api_endpoints'],
  integration: [],
};
function pickSlug(cat, card, signals) {
  let cands = [...(PREFERRED[cat] ?? [])];
  if (signals.looksLikeSpa && cat === 'cms') cands = ['vapt_web_app_dynamic_pages', ...cands];
  for (const s of cands) {
    if (card.serviceLines.some((x) => x.slug === s)) return s;
  }
  return null;
}
function pickMeth(sl) {
  const ms = new Set(sl.tiers.map((t) => t.methodology));
  ms.delete(null);
  return ms.size === 1 ? [...ms][0] : null;
}
function dim(scope, n) {
  return scope === 'pages' ? { pages: n } : scope === 'apis' ? { apis: n } : { other: n };
}
const entities = [];
for (const s of summaries) {
  const slug = pickSlug(s.category, canonical, signals);
  if (!slug) {
    entities.push({ entityId: `site-enum:${s.category}`, serviceLineSlug: 'other', dimensions: { other: s.count }, methodology: null, customerType: 'external' });
    continue;
  }
  const sl = canonical.serviceLines.find((x) => x.slug === slug);
  entities.push({
    entityId: `site-enum:${s.category}`,
    serviceLineSlug: slug,
    dimensions: dim(sl.scopeUnit, s.count),
    methodology: pickMeth(sl),
    customerType: 'external',
  });
}
// Derived: web input fields
{
  const sl = canonical.serviceLines.find((x) => x.slug === 'vapt_web_app_input_fields');
  entities.push({
    entityId: 'site-enum:web_input_fields',
    serviceLineSlug: sl.slug,
    dimensions: dim(sl.scopeUnit, signals.totalFormFields),
    methodology: pickMeth(sl),
    customerType: 'external',
  });
}
// Derived: estimated API input fields = round(49 * 1.5) = 74
{
  const apiCount = summaries.find((s) => s.category === 'api')?.count ?? 0;
  const est = Math.round(apiCount * 1.5);
  const sl = canonical.serviceLines.find((x) => x.slug === 'vapt_api_input_fields');
  entities.push({
    entityId: 'site-enum:api_input_fields:estimated',
    serviceLineSlug: sl.slug,
    dimensions: dim(sl.scopeUnit, est),
    methodology: pickMeth(sl),
    customerType: 'external',
  });
}

const result = computeBasePrice(canonical, entities);
console.log('\n=== SIMULATED QUOTE for investos.world ===');
console.log('Rate card:', canonical.name, '(' + canonical.currency + ')');
console.log('Entities passed to pricer:', entities.length);
console.log('\nLine items:');
console.log('  ' + 'Service line'.padEnd(40) + 'Qty/scope'.padEnd(14) + 'Tier'.padEnd(20) + 'Price (INR)');
console.log('  ' + '-'.repeat(90));
let total = 0;
for (const line of result.lines) {
  const qty = line.scopeValue + ' ' + line.scopeUnit;
  const tier = line.tierLabel ?? (line.unmatched ? `unmatched: ${line.unmatched.reason}` : line.manualQuoteRequired ? 'manual quote' : '—');
  const price = line.unmatched || line.manualQuoteRequired ? '—' : (line.priceCents / 100).toLocaleString();
  console.log('  ' + line.serviceLineName.padEnd(40) + qty.padEnd(14) + tier.padEnd(20) + price.padStart(12));
  if (!line.unmatched && !line.manualQuoteRequired) total += line.priceCents;
}
console.log('  ' + '-'.repeat(90));
console.log('  ' + 'TOTAL'.padEnd(74) + 'INR ' + (total / 100).toLocaleString().padStart(12));
console.log('\nReported by computeBasePrice:', (result.totalCents / 100).toLocaleString(), result.currency);
console.log('hasManualQuoteRequired:', result.hasManualQuoteRequired, '· hasUnmatched:', result.hasUnmatched);
await p.$disconnect();
