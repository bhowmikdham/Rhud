/**
 * P0a proof: the heuristic fallback (LLM-down path) is DOMAIN-AGNOSTIC.
 *
 * The audit's biggest finding was that the fallback engine hardcoded VAPT
 * vocabulary, so a non-VAPT tenant got phantom security lines (or nothing) the
 * moment the LLM hiccupped. These tests use a CLEANING-SERVICES rate card with
 * no security slugs and assert:
 *   (a) with no heuristicConfig, the fallback emits NO phantom VAPT lines
 *       (the VAPT defaults key on slugs this card doesn't have → inert);
 *   (b) with a heuristicConfig authored on the card, the fallback maps the
 *       cleaning doc correctly — same machinery, different domain, zero code.
 */
import { describe, it, expect } from 'vitest';
import type { LlmService } from '../llm/llm.service.js';
import {
  RateCardFieldMapperService,
  type ExtractedPointInput,
} from './rate-card-mapper.service.js';
import type { RateCard, RateCardHeuristicConfig, RateCardServiceLine } from '@rhud/shared';

// 'manual' provider → inferEntities skips the LLM, exercising the heuristic.
const mapper = new RateCardFieldMapperService(
  { getProviderName: async () => 'manual' } as unknown as LlmService,
);

function line(slug: string, displayName: string): RateCardServiceLine {
  return {
    id: `sl-${slug}`,
    slug,
    displayName,
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 0,
    tiers: (['external', 'internal'] as const).map((ct) => ({
      id: `${slug}-${ct}`,
      rangeMin: 1,
      rangeMax: null,
      methodology: null, // cleaning has no black/grey/white-box notion
      customerType: ct,
      priceCents: 50_000,
    })),
  };
}

function cleaningCard(heuristicConfig?: RateCardHeuristicConfig): RateCard {
  return {
    id: 'rc-clean',
    tenantId: 't-clean',
    name: 'Sparkle Facilities — Cleaning Rate Card',
    version: 1,
    status: 'published',
    currency: 'INR',
    serviceLines: [
      line('clean_office_rooms', 'Office Room Deep Clean'),
      line('clean_windows', 'Window & Pane Cleaning'),
      line('clean_kitchens', 'Kitchen Deep Clean'),
    ],
    openPricedServices: [],
    ...(heuristicConfig ? { heuristicConfig } : {}),
  };
}

const CLEANING_POINTS: ExtractedPointInput[] = [
  { key: 'office_rooms', label: 'Number of office rooms to clean', value: '20', category: 'scope' },
  { key: 'windows', label: 'Windows / panes to clean', value: '15', category: 'scope' },
  // An identity field with a number AND a security-flavoured word — must never
  // produce scope or a phantom security line.
  { key: 'site_contact', label: 'Site contact', value: 'Firewall Road office, 8 staff', category: 'identity' },
];

const CLEANING_HEURISTIC: RateCardHeuristicConfig = {
  keywordTokens: [
    { token: 'room', aliases: ['room', 'rooms', 'office room'] },
    { token: 'window', aliases: ['window', 'windows', 'pane', 'panes'] },
    { token: 'kitchen', aliases: ['kitchen', 'kitchens'] },
  ],
  scopeUnitPatterns: { other: ['room', 'window', 'pane', 'kitchen', 'office'] },
  urlCountSlug: null, // cleaning has no cloud-instance analogue
};

describe('domain-generality — heuristic fallback on a NON-VAPT (cleaning) rate card', () => {
  it('without heuristicConfig: emits NO phantom VAPT lines (safe, even if uncovered)', async () => {
    const out = await mapper.inferEntities('t', CLEANING_POINTS, cleaningCard());
    // The crucial guarantee: never invent security lines the card never had.
    expect(out.every((e) => !e.serviceLineSlug.startsWith('vapt_'))).toBe(true);
    // The VAPT default tokens don't match cleaning slugs → nothing emitted.
    expect(out).toHaveLength(0);
  });

  it('with heuristicConfig: maps the cleaning doc correctly (same machinery, new domain)', async () => {
    const out = await mapper.inferEntities('t', CLEANING_POINTS, cleaningCard(CLEANING_HEURISTIC));
    const bySlug = new Map(out.map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.get('clean_office_rooms')?.scopeValue).toBe(20);
    expect(bySlug.get('clean_windows')?.scopeValue).toBe(15);
    // The identity field "Firewall Road office, 8 staff" must NOT leak a count
    // (category-gate) and must NOT phantom a security line (no such slug).
    for (const e of out) {
      expect(e.scopeValue).not.toBe(8);
      expect(e.serviceLineSlug.startsWith('vapt_')).toBe(false);
    }
    // Kitchens weren't mentioned → not emitted.
    expect(bySlug.has('clean_kitchens')).toBe(false);
  });
});
