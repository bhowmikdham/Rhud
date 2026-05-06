import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const ids = await p.$queryRaw`SELECT id FROM rate_cards WHERE id::text LIKE '5e98c7e7%'`;
if (!ids[0]) { console.log('No rate card with prefix 5e98c7e7.'); process.exit(0); }
const card = await p.rateCard.findUnique({
  where: { id: ids[0].id },
  include: {
    serviceLines: { include: { tiers: true }, orderBy: { position: 'asc' } },
    openPricedServices: { orderBy: { position: 'asc' } },
  },
});
console.log('Card:', card.name, 'v' + card.version, '·', card.currency, '·', card.status);
console.log('Tenant:', card.tenantId);
console.log('Inference context:', (card.inferenceContext ?? '').slice(0, 200));
console.log('Default methodology:', (card.defaultMethodologyRule ?? '').slice(0, 200));
console.log('\n── Service lines (' + card.serviceLines.length + ') ──');
for (const sl of card.serviceLines) {
  console.log('\n[' + sl.position + '] slug=' + sl.slug + '  ' + sl.displayName + '  scope=' + sl.scopeUnit + '  model=' + sl.pricingModel);
  if (sl.inferenceHint) console.log('  hint:', sl.inferenceHint.slice(0, 160));
  const sorted = sl.tiers.slice().sort((a, b) =>
    (a.customerType + (a.methodology ?? '') + a.rangeMin).localeCompare(
      b.customerType + (b.methodology ?? '') + b.rangeMin,
    ),
  );
  for (const t of sorted) {
    const range = t.rangeMax === null ? (t.rangeMin + '+') : (t.rangeMin + '-' + t.rangeMax);
    const price = (Number(t.priceCents) / 100).toLocaleString();
    const ct = t.customerType.padEnd(8);
    const m = (t.methodology ?? 'any').padEnd(12);
    console.log('    [' + ct + '/' + m + '] ' + range.padStart(10) + '  ' + card.currency + ' ' + price.padStart(12) + '  (' + (t.displayLabel ?? '') + ')');
  }
}
console.log('\n── Open-priced services (' + card.openPricedServices.length + ') ──');
for (const o of card.openPricedServices) {
  console.log('  ' + o.slug + '  ' + o.displayName + '  ' + (o.category ?? ''));
}
await p.$disconnect();
