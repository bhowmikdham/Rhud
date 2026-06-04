/**
 * Site enumeration orchestrator.
 *
 * Owns the full lifecycle of a `SiteEnumeration` row: kickoff, fire
 * the crawler, run classification, persist per-page rows, build the
 * per-category summary, optionally cache a per-rate-card mapping
 * snapshot, queue retries on transient failures, and run a tiny cron
 * (modelled after ExtractionService) to dispatch due retries.
 *
 * State machine (mirrors EngagementFile.extraction_status):
 *   pending → crawling → classifying → ready
 *                                   └─→ failed
 *                                   └─→ retry_queued → crawling (cron)
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type RateCard,
  type ScopedEntity,
  type SiteEnumerationCategorySummary,
  type SiteEnumerationMappedSnapshot,
  type SiteEnumerationOptions,
  type SiteEnumerationStateView,
  type SiteEnumerationStatus,
  type SiteUrlCategory,
  SITE_URL_CATEGORIES,
} from '@rhud/shared';

const PrismaJsonNull = Prisma.JsonNull;
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { PricingService } from '../pricing/pricing.service.js';
import { ThreadService } from '../thread/thread.service.js';
import { CrawlerService, type CrawlOptions } from './crawler.service.js';
import { JsCrawlerService } from './js-crawler.service.js';
import { SiteClassifierService, type ClassifiedPage } from './classifier.service.js';
import { SiteScopeMapperService } from './mapper.service.js';
import { assertPublicUrl, SsrfError } from './ssrf-guard.js';

const MAX_RETRY_ATTEMPTS = 3;

/** Backoff schedule for retry-queued enumerations. Aligned with the
 *  extraction service's table — first retry waits 90s, then doubles. */
const RETRY_DELAY_MS = [
  90_000,
  180_000,
  300_000,
];

/** Cron tick — sweep every 30s, same as ExtractionService. */
const RETRY_TICK_MS = 30_000;

export interface KickoffResult {
  enumerationId: string;
  status: SiteEnumerationStatus;
}

export interface DiscoveredPageRow {
  url: string;
  category: string | null;
  title: string | null;
  description: string | null;
  httpStatus: number | null;
  contentType: string | null;
  classifierSource: string | null;
  classifierConfidence: number | null;
  fetchedAt: string;
}

@Injectable()
export class SiteEnumService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SiteEnumService.name);
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly unscoped: UnscopedDb,
    private readonly crawler: CrawlerService,
    private readonly jsCrawler: JsCrawlerService,
    private readonly classifier: SiteClassifierService,
    private readonly mapper: SiteScopeMapperService,
    private readonly pricing: PricingService,
    private readonly thread: ThreadService,
  ) {}

  onModuleInit(): void {
    this.retryTimer = setInterval(() => {
      void this.sweepDueRetries().catch((e) => {
        this.logger.warn(`site-enum retry sweep failed: ${(e as Error).message}`);
      });
    }, RETRY_TICK_MS);
    this.retryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  // ── Public surface ────────────────────────────────────────────────

  /** Start a new enumeration for the engagement. Idempotent — if one
   *  exists in a non-terminal state, returns it. If it's already in a
   *  terminal state (`ready` / `failed`) and the URL is the same, the
   *  caller should DELETE first or use the `retry` endpoint. */
  async kickoff(
    tenantId: string,
    engagementId: string,
    siteUrl: string,
    options: SiteEnumerationOptions,
  ): Promise<KickoffResult> {
    if (!isPlausibleUrl(siteUrl)) {
      throw new NotFoundException('invalid_site_url');
    }
    // SSRF: reject URLs that resolve to private/internal hosts up front. The
    // crawlers re-check at fetch/navigation time, but this returns a clean 400
    // before any enumeration row is created.
    const trimmed = siteUrl.trim();
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      await assertPublicUrl(normalized);
    } catch (e) {
      if (e instanceof SsrfError) throw new BadRequestException('site_url_not_publicly_reachable');
      throw e;
    }
    const id = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      const existing = await db.siteEnumeration.findUnique({
        where: { engagementId },
      });

      // Same URL + non-terminal → return existing.
      if (existing && existing.siteUrl === siteUrl &&
          ['pending', 'crawling', 'classifying', 'retry_queued'].includes(existing.status)) {
        return existing.id;
      }

      const baseData = {
        tenantId,
        engagementId,
        siteUrl,
        status: 'pending' as const,
        startedAt: null as Date | null,
        completedAt: null as Date | null,
        totalUrls: 0,
        classifiedUrls: 0,
        categoriesJson: PrismaJsonNull,
        inferredEntities: PrismaJsonNull,
        optionsJson: options as unknown as object,
        attempts: 0,
        retryAt: null as Date | null,
        error: null as string | null,
      };

      if (existing) {
        // Replace — different URL, or terminal state. Cascade-delete
        // page rows to keep the table clean.
        await db.siteEnumerationPage.deleteMany({
          where: { enumerationId: existing.id },
        });
        await db.siteEnumeration.update({
          where: { id: existing.id },
          data: {
            ...baseData,
            categoriesJson: PrismaJsonNull,
            inferredEntities: PrismaJsonNull,
          },
        });
        return existing.id;
      }
      const created = await db.siteEnumeration.create({ data: baseData });
      return created.id;
    });

    // Fire-and-forget — heavy work runs after the request returns.
    void this.runEnumeration(tenantId, id).catch((e) => {
      this.logger.error(`site-enum runner crashed id=${id}: ${(e as Error).message}`);
    });
    return { enumerationId: id, status: 'pending' };
  }

  /** Manual retry — flips the status back to pending and re-fires the
   *  worker. Resets the attempts counter so the rep gets the full
   *  retry budget again. */
  async retry(tenantId: string, enumerationId: string): Promise<KickoffResult> {
    await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.siteEnumeration.findUnique({
        where: { id: enumerationId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException('site_enumeration_not_found');
      await db.siteEnumeration.update({
        where: { id: enumerationId },
        data: {
          status: 'pending',
          attempts: 0,
          retryAt: null,
          error: null,
        },
      });
    });
    void this.runEnumeration(tenantId, enumerationId).catch(() => undefined);
    return { enumerationId, status: 'pending' };
  }

  /** Read model for `GET /opportunities/:id/site-enumeration`. */
  async getState(
    tenantId: string,
    engagementId: string,
  ): Promise<SiteEnumerationStateView | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.siteEnumeration.findUnique({
        where: { engagementId },
      });
      if (!row) return null;
      return rowToStateView(row);
    });
  }

  /** Full list of every discovered page (URL, title, category,
   *  classifier confidence, etc.) for an engagement. Used by the CSV
   *  exporter and the "view all" detail view. */
  async listPages(
    tenantId: string,
    engagementId: string,
  ): Promise<DiscoveredPageRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const enumeration = await db.siteEnumeration.findUnique({
        where: { engagementId },
        select: { id: true },
      });
      if (!enumeration) return [];
      const rows = await db.siteEnumerationPage.findMany({
        where: { enumerationId: enumeration.id },
        orderBy: [{ category: 'asc' }, { url: 'asc' }],
      });
      return rows.map((r) => ({
        url: r.url,
        category: r.category,
        title: r.title,
        description: r.description,
        httpStatus: r.httpStatus,
        contentType: r.contentType,
        classifierSource: r.classifierSource,
        classifierConfidence: r.classifierConfidence,
        fetchedAt: r.fetchedAt.toISOString(),
      }));
    });
  }

  /** Stream-friendly CSV serialisation of `listPages`. Newline-
   *  delimited UTF-8 with double-quoted fields; safe to feed into
   *  Excel / Google Sheets / cat. */
  async exportPagesCsv(
    tenantId: string,
    engagementId: string,
  ): Promise<string> {
    const rows = await this.listPages(tenantId, engagementId);
    const header = [
      'category',
      'url',
      'title',
      'description',
      'http_status',
      'content_type',
      'classifier_source',
      'classifier_confidence',
      'fetched_at',
    ];
    const lines: string[] = [header.join(',')];
    for (const r of rows) {
      lines.push([
        csvCell(r.category),
        csvCell(r.url),
        csvCell(r.title),
        csvCell(r.description),
        csvCell(r.httpStatus),
        csvCell(r.contentType),
        csvCell(r.classifierSource),
        csvCell(r.classifierConfidence),
        csvCell(r.fetchedAt),
      ].join(','));
    }
    return lines.join('\n');
  }

  /** Map this enumeration's category breakdown onto the supplied rate
   *  card and cache the result. Idempotent — re-calling with the same
   *  rate-card id overwrites the snapshot. Reads the persisted crawl
   *  signals (totalFormFields, looksLikeSpa) so the mapper can emit
   *  derived entities and pick SPA-aware page tiers. */
  async mapToRateCard(
    tenantId: string,
    engagementId: string,
    rateCardId: string,
  ): Promise<ScopedEntity[]> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.siteEnumeration.findUnique({ where: { engagementId } }),
    );
    if (!row) throw new NotFoundException('site_enumeration_not_found');
    if (row.status !== 'ready') throw new NotFoundException('site_enumeration_not_ready');

    const summaries = readSummaries(row.categoriesJson);
    const meta = readPricingSignals(row.categoriesJson);
    const card = await this.pricing.getById(tenantId, rateCardId);
    const entities = this.mapper.map(summaries, card, meta);

    await this.tenantDb.run(tenantId, async (db) => {
      const prior = readMappedSnapshots(row.inferredEntities);
      const next = prior.filter((s) => s.rateCardId !== rateCardId);
      next.push({
        rateCardId,
        rateCardVersion: card.version,
        computedAt: new Date().toISOString(),
        entities,
      });
      await db.siteEnumeration.update({
        where: { id: row.id },
        data: { inferredEntities: next as unknown as object },
      });
    });
    return entities;
  }

  /** Convenience helper: map → quote against the engagement's default
   *  rate card, all in one call. Returns the BasePriceResult shape. */
  async quoteAgainstDefaultRateCard(
    tenantId: string,
    engagementId: string,
  ): Promise<{
    rateCardId: string;
    entities: ScopedEntity[];
    /** BasePriceResult — see @rhud/shared. */
    quote: Awaited<ReturnType<PricingService['quote']>>;
  }> {
    const rateCardId = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { template: { select: { rateCardId: true } } },
      });
      return eng?.template?.rateCardId ?? null;
    });
    if (!rateCardId) {
      throw new NotFoundException('engagement_template_has_no_rate_card');
    }
    const entities = await this.mapToRateCard(tenantId, engagementId, rateCardId);
    const quote = await this.pricing.quote(tenantId, rateCardId, entities);
    return { rateCardId, entities, quote };
  }

  // ── Worker — invoked by kickoff/retry/cron, never directly ────────

  private async runEnumeration(tenantId: string, enumerationId: string): Promise<void> {
    // Move to `crawling` and capture the URL + options for the run.
    const head = await this.tenantDb
      .run(tenantId, async (db) => {
        const row = await db.siteEnumeration.findUnique({
          where: { id: enumerationId },
        });
        if (!row) return null;
        // Don't double-fire if a previous worker is already running.
        if (row.status === 'crawling' || row.status === 'classifying') return null;
        await db.siteEnumeration.update({
          where: { id: enumerationId },
          data: {
            status: 'crawling',
            startedAt: new Date(),
            error: null,
            retryAt: null,
            totalUrls: 0,
            classifiedUrls: 0,
          },
        });
        return {
          siteUrl: row.siteUrl,
          engagementId: row.engagementId,
          options: (row.optionsJson ?? {}) as SiteEnumerationOptions,
        };
      })
      .catch(() => null);
    if (!head) return;

    let crawlResult;
    try {
      // JS rendering is opt-in via options.useJsRendering. The UI
      // surfaces it as a separate "Re-crawl with JavaScript rendering"
      // button after a static crawl detects an SPA catch-all.
      crawlResult = head.options?.useJsRendering
        ? await this.jsCrawler.crawl(head.siteUrl, head.options as CrawlOptions)
        : await this.crawler.crawl(head.siteUrl, head.options as CrawlOptions);
    } catch (e) {
      await this.markFailedOrRetry(tenantId, enumerationId, head.siteUrl, head.engagementId, `crawl_failed:${(e as Error).message}`);
      return;
    }

    // Persist page rows + bump totals.
    await this.tenantDb.run(tenantId, async (db) => {
      await db.siteEnumeration.update({
        where: { id: enumerationId },
        data: {
          totalUrls: crawlResult.pages.length,
          status: 'classifying',
        },
      });
      // CreateMany is much faster than per-row create. Skip duplicates
      // (sitemap can list a URL the BFS also reaches).
      await db.siteEnumerationPage.createMany({
        data: crawlResult.pages.map((p) => ({
          tenantId,
          enumerationId,
          url: p.url,
          httpStatus: p.httpStatus,
          contentType: p.contentType,
          title: p.title,
          description: p.description,
          fetchedAt: p.fetchedAt,
        })),
        skipDuplicates: true,
      });
    });

    // Classify. Heuristic always runs; LLM if available.
    const rateCard = await this.loadEngagementRateCard(tenantId, head.engagementId);
    let classified: ClassifiedPage[];
    try {
      classified = await this.classifier.classify(
        tenantId,
        crawlResult.pages,
        rateCard,
        {
          onLlmFallback: (reason, message) => {
            // Surface in the audit timeline using the existing event type.
            void this.tenantDb
              .run(tenantId, (db) =>
                this.thread.emitWithin(db, tenantId, {
                  engagementId: head.engagementId,
                  eventType: 'mapper_fallback_heuristic',
                  actorType: 'system',
                  actorId: null,
                  payload: { context: 'site_enumeration', reason, message: message.slice(0, 300) },
                }),
              )
              .catch(() => undefined);
          },
        },
      );
    } catch (e) {
      // Heuristic should never throw, so this means a code bug. Surface
      // as failed with a clear message.
      await this.markFailedOrRetry(tenantId, enumerationId, head.siteUrl, head.engagementId, `classify_failed:${(e as Error).message}`);
      return;
    }

    // Persist per-page categories + roll up into the summary.
    const summaries = buildSummaries(classified);
    await this.tenantDb.run(tenantId, async (db) => {
      // Update pages with their classification. Pages were keyed on
      // url, so we update by (enumerationId, url).
      for (const c of classified) {
        await db.siteEnumerationPage.updateMany({
          where: { enumerationId, url: c.url },
          data: {
            category: c.category,
            classifierConfidence: c.confidence,
            classifierSource: c.source,
          },
        });
      }
      // We persist categories as the raw array for backward compat,
      // but tuck the SPA flag + the static-asset / form-field metrics
      // onto the same JSON column so we don't need a schema change to
      // surface them.
      const categoriesPayload = {
        v: 3,
        looksLikeSpa: crawlResult.looksLikeSpa,
        spaCatchAll: crawlResult.spaCatchAll,
        probesTried: crawlResult.probesTried,
        probesDroppedAsDuplicate: crawlResult.probesDroppedAsDuplicate,
        truncated: crawlResult.truncated,
        seedSources: crawlResult.seedSources,
        jsBundleCount: crawlResult.jsBundleCount ?? 0,
        cssFileCount: crawlResult.cssFileCount ?? 0,
        totalFormFields: crawlResult.totalFormFields ?? 0,
        techFingerprint: crawlResult.techFingerprint ?? null,
        manifest: crawlResult.manifest ?? null,
        specsFound: crawlResult.specsFound ?? [],
        serviceWorkersFound: crawlResult.serviceWorkersFound ?? [],
        categories: summaries,
      };
      await db.siteEnumeration.update({
        where: { id: enumerationId },
        data: {
          status: 'ready',
          completedAt: new Date(),
          classifiedUrls: classified.length,
          categoriesJson: categoriesPayload as unknown as object,
          attempts: 0,
          retryAt: null,
          error: null,
        },
      });
      // If the engagement has a default rate card, also auto-map so the
      // UI's "Compute quote" button has a cached snapshot ready. Pass
      // the live signals (form fields + SPA flag) so the mapper can
      // emit the derived web/api input-field entities.
      if (rateCard) {
        try {
          const entities = this.mapper.map(summaries, rateCard, {
            totalFormFields: crawlResult.totalFormFields ?? 0,
            looksLikeSpa: crawlResult.looksLikeSpa,
            customerType: 'external',
          });
          const snapshot: SiteEnumerationMappedSnapshot = {
            rateCardId: rateCard.id,
            rateCardVersion: rateCard.version,
            computedAt: new Date().toISOString(),
            entities,
          };
          await db.siteEnumeration.update({
            where: { id: enumerationId },
            data: { inferredEntities: [snapshot] as unknown as object },
          });
        } catch (e) {
          this.logger.warn(`auto-map after enumeration failed: ${(e as Error).message}`);
        }
      }
      await this.thread.emitWithin(db, tenantId, {
        engagementId: head.engagementId,
        eventType: 'site_enumerated',
        actorType: 'system',
        actorId: null,
        payload: {
          siteUrl: head.siteUrl,
          totalUrls: classified.length,
          categories: Object.fromEntries(summaries.map((s) => [s.category, s.count])),
          truncated: crawlResult.truncated,
        },
      });
    });
    this.logger.log(
      `site-enum ready id=${enumerationId} pages=${classified.length} categories=${summaries.length}`,
    );
  }

  /** Load the engagement's EFFECTIVE rate card: a card attached directly
   *  to the opportunity wins, otherwise the template's binding. Returns
   *  null when neither is set. */
  private async loadEngagementRateCard(
    tenantId: string,
    engagementId: string,
  ): Promise<RateCard | null> {
    const rateCardId = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { rateCardId: true, template: { select: { rateCardId: true } } },
      });
      return eng?.rateCardId ?? eng?.template?.rateCardId ?? null;
    });
    if (!rateCardId) return null;
    return this.pricing.getById(tenantId, rateCardId).catch(() => null);
  }

  /** Either schedule a retry (transient) or mark failed (terminal). */
  private async markFailedOrRetry(
    tenantId: string,
    enumerationId: string,
    siteUrl: string,
    engagementId: string,
    rawError: string,
  ): Promise<void> {
    const file = await this.tenantDb.run(tenantId, async (db) =>
      db.siteEnumeration.findUnique({
        where: { id: enumerationId },
        select: { attempts: true },
      }),
    );
    if (!file) return;
    const next = file.attempts + 1;
    if (next > MAX_RETRY_ATTEMPTS) {
      await this.tenantDb.run(tenantId, async (db) => {
        await db.siteEnumeration.update({
          where: { id: enumerationId },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: rawError.slice(0, 500),
            retryAt: null,
          },
        });
        await this.thread.emitWithin(db, tenantId, {
          engagementId,
          eventType: 'site_enumeration_failed',
          actorType: 'system',
          actorId: null,
          payload: { siteUrl, error: rawError.slice(0, 300), attempts: file.attempts },
        });
      });
      return;
    }
    const delay = RETRY_DELAY_MS[Math.min(next - 1, RETRY_DELAY_MS.length - 1)] ?? 300_000;
    const retryAt = new Date(Date.now() + delay);
    await this.tenantDb.run(tenantId, async (db) => {
      await db.siteEnumeration.update({
        where: { id: enumerationId },
        data: {
          status: 'retry_queued',
          attempts: next,
          retryAt,
          error: rawError.slice(0, 500),
        },
      });
    });
    this.logger.log(
      `site-enum queued-for-retry id=${enumerationId} attempt=${next}/${MAX_RETRY_ATTEMPTS} retry_at=${retryAt.toISOString()}`,
    );
  }

  private async sweepDueRetries(): Promise<void> {
    const due = await this.unscoped.findDueSiteEnumerationRetries(50);
    for (const r of due) {
      this.logger.log(`site-enum retry firing id=${r.id} attempt=${r.attempts + 1}`);
      void this.runEnumeration(r.tenantId, r.id).catch(() => undefined);
    }
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Lightweight URL sanity check. We accept anything with an http/https
 *  scheme (or no scheme — crawler will add https://) and a host. */
export function isPlausibleUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    return !!u.host && /\./.test(u.host);
  } catch {
    return false;
  }
}

/** Roll classified pages up to per-category counts + sample examples. */
export function buildSummaries(
  pages: ClassifiedPage[],
): SiteEnumerationCategorySummary[] {
  const buckets = new Map<SiteUrlCategory, ClassifiedPage[]>();
  for (const p of pages) {
    const list = buckets.get(p.category) ?? [];
    list.push(p);
    buckets.set(p.category, list);
  }
  const out: SiteEnumerationCategorySummary[] = [];
  // Iterate in canonical category order so the UI is stable.
  for (const cat of SITE_URL_CATEGORIES) {
    const list = buckets.get(cat) ?? [];
    if (list.length === 0) continue;
    out.push({
      category: cat,
      count: list.length,
      // Hand the UI the full set (not just 3) so the tech-side view
      // can show every Supabase table / RPC / REST path, grouped.
      // Each example is small (url + title); 200 entries per category
      // is comfortably under any reasonable JSON column limit.
      examples: list.slice(0, 200).map((p) => ({ url: p.url, title: p.title })),
    });
  }
  // Sort by count desc so the rep sees the biggest buckets first.
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** Convert a stored Prisma row into the wire view. */
function rowToStateView(row: {
  id: string;
  engagementId: string;
  siteUrl: string;
  status: string;
  totalUrls: number;
  classifiedUrls: number;
  startedAt: Date | null;
  completedAt: Date | null;
  retryAt: Date | null;
  attempts: number;
  error: string | null;
  categoriesJson: unknown;
  inferredEntities: unknown;
  optionsJson: unknown;
}): SiteEnumerationStateView {
  const meta = readCategoriesMeta(row.categoriesJson);
  return {
    id: row.id,
    engagementId: row.engagementId,
    siteUrl: row.siteUrl,
    status: row.status as SiteEnumerationStatus,
    totalUrls: row.totalUrls,
    classifiedUrls: row.classifiedUrls,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    retryAt: row.retryAt?.toISOString() ?? null,
    attempts: row.attempts,
    error: row.error,
    categories: meta.categories,
    looksLikeSpa: meta.looksLikeSpa,
    spaCatchAll: meta.spaCatchAll,
    jsBundleCount: meta.jsBundleCount,
    cssFileCount: meta.cssFileCount,
    totalFormFields: meta.totalFormFields,
    techFingerprint: meta.techFingerprint,
    manifest: meta.manifest,
    specsFound: meta.specsFound,
    serviceWorkersFound: meta.serviceWorkersFound,
    mappedRateCards: readMappedSnapshots(row.inferredEntities),
    options: row.optionsJson && typeof row.optionsJson === 'object'
      ? (row.optionsJson as SiteEnumerationOptions)
      : null,
  };
}

/** Public wrapper for the orchestrator's auto-map path, which already
 *  has the array form from in-memory state. Keeps the JSON-vs-array
 *  branching contained to one function. */
export function readSummaries(raw: unknown): SiteEnumerationCategorySummary[] {
  return readCategoriesMeta(raw).categories;
}

/** CSV cell escaping. Wraps in double quotes if the value contains a
 *  comma, quote, or newline; doubles internal quotes. Null/undefined
 *  serialise to an empty cell. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Pull the crawler signals (form-field total, SPA flag) out of the
 *  persisted JSON so a re-map against a different rate card can use
 *  them without re-crawling. */
export function readPricingSignals(raw: unknown): {
  totalFormFields: number;
  looksLikeSpa: boolean;
  customerType: 'external' | 'internal';
} {
  const meta = readCategoriesMeta(raw);
  return {
    totalFormFields: meta.totalFormFields,
    looksLikeSpa: meta.looksLikeSpa,
    customerType: 'external',
  };
}

interface CategoriesPayloadMeta {
  categories: SiteEnumerationCategorySummary[];
  looksLikeSpa: boolean;
  spaCatchAll: boolean;
  jsBundleCount: number;
  cssFileCount: number;
  totalFormFields: number;
  techFingerprint: { platform: string; signals: string[]; generator?: string } | null;
  manifest: { name?: string; startUrl?: string; scope?: string; shortcuts: string[] } | null;
  specsFound: string[];
  serviceWorkersFound: string[];
}

/** Tolerate both the v1 shape (array of summaries) and the v2 shape
 *  ({ v: 2, looksLikeSpa, spaCatchAll, ..., categories: [...] }). New
 *  runs always write v2; older rows fall back gracefully. */
function readCategoriesMeta(raw: unknown): CategoriesPayloadMeta {
  const empty: CategoriesPayloadMeta = {
    categories: [],
    looksLikeSpa: false, spaCatchAll: false,
    jsBundleCount: 0, cssFileCount: 0, totalFormFields: 0,
    techFingerprint: null, manifest: null,
    specsFound: [], serviceWorkersFound: [],
  };
  if (Array.isArray(raw)) {
    return { ...empty, categories: filterSummaries(raw) };
  }
  if (!raw || typeof raw !== 'object') return empty;
  const obj = raw as Record<string, unknown>;
  const num = (k: string): number => {
    const v = obj[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const strArr = (k: string): string[] => {
    const v = obj[k];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  // Tech fingerprint: object with { platform, signals[], generator? }
  let techFingerprint: CategoriesPayloadMeta['techFingerprint'] = null;
  if (obj.techFingerprint && typeof obj.techFingerprint === 'object') {
    const f = obj.techFingerprint as Record<string, unknown>;
    if (typeof f.platform === 'string') {
      techFingerprint = {
        platform: f.platform,
        signals: Array.isArray(f.signals) ? f.signals.filter((x): x is string => typeof x === 'string') : [],
        ...(typeof f.generator === 'string' ? { generator: f.generator } : {}),
      };
    }
  }
  // Manifest summary
  let manifest: CategoriesPayloadMeta['manifest'] = null;
  if (obj.manifest && typeof obj.manifest === 'object') {
    const m = obj.manifest as Record<string, unknown>;
    manifest = {
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.startUrl === 'string' ? { startUrl: m.startUrl } : {}),
      ...(typeof m.scope === 'string' ? { scope: m.scope } : {}),
      shortcuts: Array.isArray(m.shortcuts) ? m.shortcuts.filter((x): x is string => typeof x === 'string') : [],
    };
  }
  return {
    categories: filterSummaries(obj.categories),
    looksLikeSpa: obj.looksLikeSpa === true,
    spaCatchAll: obj.spaCatchAll === true,
    jsBundleCount: num('jsBundleCount'),
    cssFileCount: num('cssFileCount'),
    totalFormFields: num('totalFormFields'),
    techFingerprint,
    manifest,
    specsFound: strArr('specsFound'),
    serviceWorkersFound: strArr('serviceWorkersFound'),
  };
}

function filterSummaries(raw: unknown): SiteEnumerationCategorySummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is SiteEnumerationCategorySummary =>
    !!s && typeof s === 'object' &&
    typeof (s as { category?: unknown }).category === 'string' &&
    typeof (s as { count?: unknown }).count === 'number',
  );
}

function readMappedSnapshots(raw: unknown): SiteEnumerationMappedSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is SiteEnumerationMappedSnapshot =>
    !!s && typeof s === 'object' &&
    typeof (s as { rateCardId?: unknown }).rateCardId === 'string' &&
    Array.isArray((s as { entities?: unknown }).entities),
  );
}
