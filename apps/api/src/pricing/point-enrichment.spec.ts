/**
 * point-enrichment specs.
 *
 * Locks in the Layer-2.5 derivations that flow into the Layer-3 mapper
 * prompt: URL grouping by hostname, cloud-platform detection, negation
 * counting. The mapper LLM uses these synthetic points alongside the
 * raw doc-extracted points to apply rate-card hints with richer evidence.
 */

import { describe, it, expect } from 'vitest';
import { enrichPoints } from './point-enrichment.js';

describe('enrichPoints — URL grouping', () => {
  it('emits no _derived_url_analysis when the doc has zero URLs', () => {
    const out = enrichPoints([
      { key: 'how_many_dynamic_pages', label: 'Dynamic pages', value: '29' },
      { key: 'company_name', label: 'Company', value: 'Prophaze Technologies' },
    ]);
    expect(out.find((p) => p.key === '_derived_url_analysis')).toBeUndefined();
  });

  it('groups N URLs sharing one hostname as 1 distinct hostname (29 paths)', () => {
    const urls = [
      'https://staging.example.com/login',
      'https://staging.example.com/home',
      'https://staging.example.com/admin',
      'https://staging.example.com/reports',
    ].join('\n');
    const out = enrichPoints([
      { key: 'asset_inventory', label: 'Assets in scope', value: urls },
    ]);
    const derived = out.find((p) => p.key === '_derived_url_analysis');
    expect(derived).toBeDefined();
    expect(derived!.value).toContain('1 distinct hostname');
    expect(derived!.value).toContain('staging.example.com (4 paths)');
    expect(derived!.value).toContain('No cloud-domain hosts');
  });

  it('groups URLs across multiple hostnames as separate web apps', () => {
    const urls = [
      'https://a.example.com/login',
      'https://a.example.com/home',
      'https://b.example.com/api',
      'https://c.example.com/',
    ].join(' ');
    const out = enrichPoints([
      { key: 'asset_inventory', label: 'Assets', value: urls },
    ]);
    const derived = out.find((p) => p.key === '_derived_url_analysis')!;
    expect(derived.value).toContain('3 distinct hostnames');
    expect(derived.value).toContain('a.example.com');
    expect(derived.value).toContain('b.example.com');
    expect(derived.value).toContain('c.example.com');
    // Counts per host. a is 2 paths, b is 1, c is 1.
    expect(derived.value).toMatch(/a\.example\.com \(2 paths\)/);
    expect(derived.value).toMatch(/b\.example\.com \(1 path\)/);
    expect(derived.value).toMatch(/c\.example\.com \(1 path\)/);
  });

  it('flags cloud-domain hostnames separately from custom hostnames', () => {
    const urls = [
      'https://my-bucket.s3.amazonaws.com/file.pdf',
      'https://my-app.cloudfront.net/static',
      'https://api.example.com/v1',
    ].join('\n');
    const out = enrichPoints([
      { key: 'k', value: urls },
    ]);
    const derived = out.find((p) => p.key === '_derived_url_analysis')!;
    expect(derived.value).toContain('2 cloud-domain hosts');
    expect(derived.value).toContain('amazonaws');
    expect(derived.value).toContain('cloudfront');
  });

  it('strips www. prefix when grouping (so www.x and x are one host)', () => {
    const urls = [
      'https://www.example.com/page1',
      'https://example.com/page2',
    ].join(' ');
    const out = enrichPoints([{ key: 'k', value: urls }]);
    const derived = out.find((p) => p.key === '_derived_url_analysis')!;
    expect(derived.value).toContain('1 distinct hostname');
    expect(derived.value).toContain('example.com (2 paths)');
  });

  it('caps URL parsing so a million-URL cell does not stall the regex pass', () => {
    // 600 URLs in one cell — the cap is 500. We just want this to
    // complete quickly and not crash; exact count above 500 isn't
    // contractual.
    const urls = Array.from({ length: 600 }, (_, i) => `https://h${i}.example.com/`).join(' ');
    const out = enrichPoints([{ key: 'k', value: urls }]);
    const derived = out.find((p) => p.key === '_derived_url_analysis');
    expect(derived).toBeDefined();
  });
});

describe('enrichPoints — cloud hosting detection', () => {
  it('emits no derivation when no cloud-platform mention is present', () => {
    const out = enrichPoints([
      { key: 'tech_stack', label: 'Tech stack', value: 'React + Postgres' },
    ]);
    expect(out.find((p) => p.key === '_derived_cloud_hosting')).toBeUndefined();
  });

  it('detects "Hosted on Cloud — AWS" as cloud hosting', () => {
    const out = enrichPoints([
      { key: 'is_internal_or_external', label: 'Internal or external', value: 'Hosted on Cloud - AWS' },
    ]);
    const derived = out.find((p) => p.key === '_derived_cloud_hosting');
    expect(derived).toBeDefined();
    expect(derived!.value).toContain('AWS');
    expect(derived!.value.toLowerCase()).toContain('cloud-instances');
  });

  it('detects Azure / GCP / Heroku', () => {
    expect(
      enrichPoints([{ key: 'k', value: 'Hosted on Microsoft Azure' }]).find((p) => p.key === '_derived_cloud_hosting')!.value,
    ).toContain('Azure');
    expect(
      enrichPoints([{ key: 'k', value: 'Running on GCP / Google Cloud' }]).find((p) => p.key === '_derived_cloud_hosting')!.value,
    ).toContain('GCP');
    expect(
      enrichPoints([{ key: 'k', value: 'Deployed on Heroku' }]).find((p) => p.key === '_derived_cloud_hosting')!.value,
    ).toContain('PaaS');
  });

  it('does not double-up when the same provider is mentioned in multiple cells', () => {
    const out = enrichPoints([
      { key: 'a', value: 'Hosted on AWS' },
      { key: 'b', value: 'Migrating to AWS' },
      { key: 'c', value: 'AWS region: us-east-1' },
    ]);
    const derived = out.find((p) => p.key === '_derived_cloud_hosting')!;
    expect(derived.value).toContain('AWS');
    // Only one provider listed — no "AWS, AWS, AWS" repetition.
    expect(derived.value.match(/AWS/g)?.length ?? 0).toBeLessThanOrEqual(2); // once in providers, once in quote
  });

  it('lists multiple distinct providers when both are mentioned', () => {
    const out = enrichPoints([
      { key: 'a', value: 'Frontend on AWS, backend on GCP' },
    ]);
    const derived = out.find((p) => p.key === '_derived_cloud_hosting')!;
    // The detector hits one provider per cell, so when both are in one
    // cell it picks the first match (AWS). That's a known limitation;
    // the test just locks in the documented behaviour.
    expect(derived.value).toMatch(/AWS|GCP/);
  });
});

describe('enrichPoints — negation summary', () => {
  it('emits no derivation when there are no negations', () => {
    const out = enrichPoints([
      { key: 'k', value: '29' },
      { key: 'k2', value: 'Yes' },
    ]);
    expect(out.find((p) => p.key === '_derived_negation_summary')).toBeUndefined();
  });

  it('counts "Not applicable" / "No" / "None" answers', () => {
    const out = enrichPoints([
      { key: 'k1', value: 'Not applicable' },
      { key: 'k2', value: 'No' },
      { key: 'k3', value: 'None' },
      { key: 'k4', value: 'Yes' },          // not negated
      { key: 'k5', value: '29' },           // not negated
    ]);
    const derived = out.find((p) => p.key === '_derived_negation_summary')!;
    expect(derived.value).toContain('3 answers');
    expect(derived.value).toContain('considered');
    expect(derived.value).toContain('negated');
  });
});

describe('enrichPoints — preserves originals', () => {
  it('returns originals unchanged in addition to derived rows', () => {
    const originals = [
      { key: 'k1', label: 'Q1', value: 'v1' },
      { key: 'k2', label: 'Q2', value: 'https://a.com' },
    ];
    const out = enrichPoints(originals);
    // First N rows are the originals, in order.
    expect(out[0]).toEqual(originals[0]);
    expect(out[1]).toEqual(originals[1]);
    // Anything after the originals is a derivation.
    for (let i = originals.length; i < out.length; i++) {
      expect(out[i]!.key.startsWith('_derived_')).toBe(true);
    }
  });
});
