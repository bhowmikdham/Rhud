/**
 * Unit tests for the deterministic "light intelligence" layer that
 * supplements the LLM mapper:
 *
 *   - `detectBinaryFlags` — recognises IDS/IPS/DLP/IAM yes-flags in
 *     extracted points, regardless of phrasing.
 *   - `countCloudUrls`   — counts AWS/Azure/GCP-domain URLs in the
 *     extracted text, with filename-hint fallback for generic URLs.
 *
 * These are deterministic. Regressions here mean a real client doc
 * stops producing the right scope=1 binary entities OR the cloud
 * instance count is wrong by orders of magnitude. Both lead to silent
 * wrong prices.
 */

import { describe, it, expect } from 'vitest';
import type { RateCard } from '@rhud/shared';
import type { ExtractedPointInput } from './rate-card-mapper.service.js';
import { countCloudUrls, detectBinaryFlags } from './rate-card-mapper.service.js';

// Minimal rate card with the binary slugs the detector targets.
const RATE_CARD: RateCard = {
  id: 'rc', tenantId: 't', name: 'test', version: 1, status: 'published',
  currency: 'INR', effectiveFrom: null, effectiveTo: null, openPricedServices: [],
  serviceLines: [
    { id: 's1', slug: 'vapt_cloud_iam', displayName: 'IAM', scopeUnit: 'other', pricingModel: 'flat', position: 0, tiers: [] },
    { id: 's2', slug: 'vapt_network_ids', displayName: 'IDS', scopeUnit: 'devices', pricingModel: 'flat', position: 1, tiers: [] },
    { id: 's3', slug: 'vapt_network_ips', displayName: 'IPS', scopeUnit: 'devices', pricingModel: 'flat', position: 2, tiers: [] },
    { id: 's4', slug: 'vapt_network_dlp', displayName: 'DLP', scopeUnit: 'devices', pricingModel: 'flat', position: 3, tiers: [] },
    { id: 's5', slug: 'vapt_cloud_instances', displayName: 'Cloud', scopeUnit: 'devices', pricingModel: 'per_unit', position: 4, tiers: [] },
  ],
};

const point = (over: Partial<ExtractedPointInput> & Pick<ExtractedPointInput, 'key' | 'value'>): ExtractedPointInput => ({
  ...over,
});

describe('detectBinaryFlags', () => {
  it('matches "IAM: yes" → emits cloud_iam', () => {
    const hits = detectBinaryFlags(
      [point({ key: 'iam', label: 'IAM enabled?', value: 'yes' })],
      RATE_CARD,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe('vapt_cloud_iam');
  });

  it('matches "Intrusion Detection: deployed" → emits network_ids', () => {
    const hits = detectBinaryFlags(
      [point({ key: 'intrusion_detection', label: 'Intrusion detection system', value: 'deployed' })],
      RATE_CARD,
    );
    expect(hits.some((h) => h.slug === 'vapt_network_ids')).toBe(true);
  });

  it('does NOT match "kids" or "credentials" via the ids substring', () => {
    const hits = detectBinaryFlags(
      [
        point({ key: 'staff', label: 'Number of kids in office', value: '4' }),
        point({ key: 'credentials', label: 'Credentials approach', value: 'shared admin' }),
      ],
      RATE_CARD,
    );
    expect(hits.find((h) => h.slug === 'vapt_network_ids')).toBeUndefined();
  });

  it('matches "IPS" with surrounding non-letters', () => {
    const hits = detectBinaryFlags(
      [point({ key: 'security', label: '(IPS) deployed?', value: 'yes' })],
      RATE_CARD,
    );
    expect(hits.find((h) => h.slug === 'vapt_network_ips')).toBeDefined();
  });

  it('does NOT match a "no" answer (positive-value gate)', () => {
    const hits = detectBinaryFlags(
      [point({ key: 'iam', label: 'IAM enabled?', value: 'no' })],
      RATE_CARD,
    );
    expect(hits.find((h) => h.slug === 'vapt_cloud_iam')).toBeUndefined();
  });

  it('skips slugs not present in the rate card', () => {
    const sparseCard: RateCard = { ...RATE_CARD, serviceLines: [] };
    const hits = detectBinaryFlags(
      [point({ key: 'iam', label: 'IAM enabled?', value: 'yes' })],
      sparseCard,
    );
    expect(hits).toHaveLength(0);
  });
});

describe('countCloudUrls', () => {
  it('counts AWS-domain URLs with confidence 0.85', () => {
    const result = countCloudUrls(
      [
        point({ key: 'urls', value: 'https://api.eu-west-1.amazonaws.com/foo\nhttps://bucket.s3.amazonaws.com/bar' }),
      ],
      null,
    );
    expect(result.count).toBe(2);
    expect(result.confidence).toBe(0.85);
    expect(result.flavor).toBe('cloud-domain');
  });

  it('counts generic URLs only when filename hint suggests cloud', () => {
    const result = countCloudUrls(
      [point({ key: 'links', value: 'https://example.com/a\nhttps://example.com/b\nhttps://example.com/c' })],
      'aws_inventory.xlsx',
    );
    expect(result.count).toBe(3);
    expect(result.confidence).toBe(0.7);
  });

  it('returns count=0 when generic URLs have no cloud filename hint', () => {
    const result = countCloudUrls(
      [point({ key: 'misc', value: 'https://example.com/a\nhttps://example.com/b' })],
      'questionnaire.xlsx',
    );
    expect(result.count).toBe(0);
  });

  it('caps at MAX_URL_HITS so a doc with thousands of URLs does not blow up', () => {
    const url = 'https://x.amazonaws.com/foo';
    const huge = Array(2_000).fill(url).join('\n');
    const result = countCloudUrls([point({ key: 'urls', value: huge })], null);
    // Cap is 500 (MAX_URL_HITS) — defined inside the helper.
    expect(result.count).toBeLessThanOrEqual(500);
    expect(result.count).toBeGreaterThanOrEqual(490);
  });

  it('mixes cloud + generic, prefers cloud when present', () => {
    const result = countCloudUrls(
      [point({ key: 'urls', value: 'https://x.amazonaws.com/a\nhttps://example.com/b' })],
      null,
    );
    expect(result.count).toBe(1); // only the cloud hit
    expect(result.flavor).toBe('cloud-domain');
  });
});
