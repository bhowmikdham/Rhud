/**
 * Layer 2.5 — point enrichment.
 *
 * The Layer-3 mapper LLM is only as good as the data it sees. When a
 * client questionnaire pastes 29 URLs into one cell, the LLM has to
 * eyeball the cell, parse URLs, group by hostname, classify cloud-domain
 * vs custom — all noise that distracts it from the actual classification
 * task. Same for "Hosted on Cloud — AWS" answers: the LLM doesn't always
 * remember to think about cloud_instances scope when the doc only
 * mentions hosting in passing.
 *
 * `enrichPoints` runs BEFORE the mapper composes its prompt. It
 * scans the raw extracted points and emits **derived points** — new
 * `ExtractedPointInput` rows with key=`_derived_*` whose value is a
 * structured English summary of what the system noticed. The mapper
 * passes them through to the LLM alongside the originals; the LLM
 * uses them as additional evidence when applying the rate card's
 * inference hints.
 *
 * Pure function: same input → same output, no I/O. Easy to unit-test.
 */

import type { ExtractedPointInput } from './rate-card-mapper.service.js';

/** Cloud-domain hostname suffixes — used by both URL grouping and the
 *  cloud-hosting detector to flag platform mentions. */
const CLOUD_DOMAIN_RE = /\.(amazonaws|cloudfront|googleapis|cloud\.goog|s3)\b/i;
const CLOUD_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\b(aws|amazon\s+web\s+services|amazon\s+cloud)\b/i, provider: 'AWS' },
  { pattern: /\b(azure|microsoft\s+azure|az\s+cloud)\b/i, provider: 'Azure' },
  { pattern: /\b(gcp|google\s+cloud|google\s+cloud\s+platform)\b/i, provider: 'GCP' },
  { pattern: /\b(digitalocean|digital\s+ocean|do\s+droplet)\b/i, provider: 'DigitalOcean' },
  { pattern: /\b(linode|akamai\s+cloud)\b/i, provider: 'Linode' },
  { pattern: /\b(heroku|render\.com|fly\.io|railway\.app)\b/i, provider: 'PaaS' },
  { pattern: /\bhosted\s+on\s+cloud\b/i, provider: 'cloud' },
];

/** Phrases the LLM might miss when scanning cells for "this slug doesn't
 *  apply" — we surface these as a tag the LLM can rely on. */
const NEGATION_PATTERNS: RegExp[] = [
  /^(no|none|n\/?a|not\s+applicable|nil|nothing|not\s+in\s+scope|not\s+required|not\s+needed)\b/i,
  /^(no\s+such|no\s+\w+\s+(?:in|defined|configured|present))\b/i,
  /\b(intentionally\s+left\s+blank|to\s+be\s+determined|tbd)\b/i,
];

const URL_RE = /\bhttps?:\/\/[^\s,;<>"'`]+/gi;

/**
 * Run all enrichment passes and return the augmented points list.
 * Originals are preserved verbatim — derived points are appended with
 * `key=_derived_*` so the mapper can pass them to the LLM unchanged.
 *
 * Bounded: caps URL parsing at MAX_URLS to avoid stalling on huge sheets.
 */
export function enrichPoints(points: ExtractedPointInput[]): ExtractedPointInput[] {
  const enriched: ExtractedPointInput[] = [...points];

  const urlAnalysis = analyseUrlList(points);
  if (urlAnalysis) {
    enriched.push({
      key: '_derived_url_analysis',
      label: 'Derived: URL list grouped by hostname',
      value: urlAnalysis,
    });
  }

  const cloudHosting = detectCloudHosting(points);
  if (cloudHosting) {
    enriched.push({
      key: '_derived_cloud_hosting',
      label: 'Derived: cloud-hosting platform detected',
      value: cloudHosting,
    });
  }

  const negationCount = countNegations(points);
  if (negationCount > 0) {
    enriched.push({
      key: '_derived_negation_summary',
      label: 'Derived: negation phrases detected',
      value:
        `${negationCount} answer${negationCount === 1 ? '' : 's'} in the document evaluate to a ` +
        `negation ("No" / "None" / "Not applicable" / etc.). Slugs whose only evidence is one of ` +
        `those answers must NOT be emitted — list them in "considered" with reason="negated".`,
    });
  }

  return enriched;
}

/** Maximum URLs to parse before giving up (bounded so a 100k-cell sheet
 *  doesn't lock the regex pass). 200 is plenty for any real questionnaire. */
const MAX_URLS = 500;

/**
 * Scan every cell for URLs, group by hostname, classify cloud-domain.
 * Returns null when no URLs are found — the mapper skips emitting an
 * empty derivation. Returns a one-line English summary otherwise.
 *
 * Format examples:
 *   "29 URLs across 1 distinct hostname: staging.example.com (29 paths). No cloud-domain hosts."
 *   "5 URLs across 3 distinct hostnames: a.com (2 paths), b.com (2 paths), c.com (1 path). 1 cloud-domain host: my-bucket.s3.amazonaws.com."
 */
function analyseUrlList(points: ExtractedPointInput[]): string | null {
  const urls: string[] = [];
  for (const p of points) {
    const matches = (p.value ?? '').match(URL_RE) ?? [];
    for (const u of matches) {
      urls.push(u);
      if (urls.length >= MAX_URLS) break;
    }
    if (urls.length >= MAX_URLS) break;
  }
  if (urls.length === 0) return null;

  const byHost = new Map<string, number>();
  const cloudHosts: string[] = [];
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue; // malformed URL — drop
    }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
    if (CLOUD_DOMAIN_RE.test(host) && !cloudHosts.includes(host)) {
      cloudHosts.push(host);
    }
  }
  if (byHost.size === 0) return null;

  const hostList = [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([h, n]) => `${h} (${n} path${n === 1 ? '' : 's'})`)
    .join(', ');
  const totalUrls = [...byHost.values()].reduce((a, b) => a + b, 0);
  const hostCount = byHost.size;
  const cloudClause =
    cloudHosts.length > 0
      ? `${cloudHosts.length} cloud-domain host${cloudHosts.length === 1 ? '' : 's'}: ${cloudHosts.join(', ')}.`
      : 'No cloud-domain hosts.';

  return (
    `${totalUrls} URL${totalUrls === 1 ? '' : 's'} across ${hostCount} distinct hostname` +
    `${hostCount === 1 ? '' : 's'}: ${hostList}. ${cloudClause} ` +
    `Note: distinct hostnames are SEPARATE applications (give each a unique appId); paths sharing ` +
    `a hostname are children of that application's page/screen driver.`
  );
}

/**
 * Look for cloud-platform mentions across all cells. Returns null when
 * no provider is named. Otherwise returns an English summary the LLM
 * can use to decide whether vapt_cloud_instances (or whatever the
 * tenant's cloud-related slug is called) should be emitted.
 */
function detectCloudHosting(points: ExtractedPointInput[]): string | null {
  const hits: Array<{ provider: string; quote: string }> = [];
  for (const p of points) {
    const haystack = `${p.value ?? ''}`;
    for (const { pattern, provider } of CLOUD_PROVIDER_PATTERNS) {
      if (pattern.test(haystack)) {
        hits.push({ provider, quote: haystack.slice(0, 120) });
        break; // one provider hit per cell is enough
      }
    }
  }
  if (hits.length === 0) return null;

  // Collapse to unique providers in order of first occurrence.
  const seen = new Set<string>();
  const unique: typeof hits = [];
  for (const h of hits) {
    if (seen.has(h.provider)) continue;
    seen.add(h.provider);
    unique.push(h);
  }
  const providers = unique.map((h) => h.provider).join(', ');
  const sample = unique[0]!.quote;
  return (
    `Application is hosted on ${providers} (per: "${sample}"). Cloud platform is part of the ` +
    `engagement context — consider whether cloud-related service lines (instances, databases, IAM, ` +
    `etc.) should be scoped. If the doc gives no instance count, default to scope=1 with confidence ` +
    `0.7 for the primary cloud-instances slug.`
  );
}

/**
 * Count how many cells have a value that's purely a negation phrase
 * ("No", "None", "Not applicable"). The LLM occasionally misses these
 * when the surrounding question is technical; the summary nudges it.
 */
function countNegations(points: ExtractedPointInput[]): number {
  let n = 0;
  for (const p of points) {
    const v = (p.value ?? '').trim();
    if (v.length === 0) continue;
    if (NEGATION_PATTERNS.some((re) => re.test(v))) n++;
  }
  return n;
}
