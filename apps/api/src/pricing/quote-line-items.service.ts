/**
 * Phase A — additional quote line items (travel, tools, resource costs,
 * discounts, custom).
 *
 * The base quote (rate-card lookups) lives in EngagementQuote.
 * EngagementQuoteLineItem holds the reviewer-added extras. Reads fold
 * both into a single QuoteTotalsBreakdown so the UI doesn't have to
 * sum client-side.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import {
  QUOTE_LINE_ITEM_KINDS,
  type CreateQuoteLineItemInput,
  type QuoteLineItemKind,
  type QuoteLineItemRow,
  type QuoteTotalsBreakdown,
  type UpdateQuoteLineItemInput,
} from '@rhud/shared';

/**
 * The LIVE cents for a line item. A percentage discount is recomputed against
 * the CURRENT base every time it's consumed — the stored `amountCents` is only a
 * create-time snapshot and goes STALE after a re-quote changes `baseTotalCents`
 * (a "10% off" entered at base ₹50k must become −₹10k once the scope grows the
 * base to ₹100k, not stay −₹5k). Fixed-cents rows return their stored amount.
 * `percentageBps` is the single source of truth; `amountCents` is display history.
 * Used by BOTH the breakdown read and the approval fold so they can never diverge.
 */
export function effectiveLineItemCents(
  item: { amountCents: number | bigint; percentageBps: number | null },
  baseTotalCents: number,
): number {
  if (item.percentageBps != null) {
    // Percentage rows are discount-only (enforced at create) → always negative.
    return -Math.round((baseTotalCents * Math.abs(item.percentageBps)) / 10_000);
  }
  return Number(item.amountCents);
}

@Injectable()
export class QuoteLineItemsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  /** List + totals breakdown for one engagement's quote. */
  async getBreakdown(tenantId: string, engagementId: string): Promise<QuoteTotalsBreakdown> {
    return this.tenantDb.run(tenantId, async (db) => {
      const quote = await db.engagementQuote.findUnique({
        where: { engagementId },
        select: { id: true, baseTotalCents: true },
      });
      if (!quote) {
        // No quote yet — return zeros. Callers handle the "no quote
        // yet" case in their UI.
        return {
          baseTotalCents: 0,
          lineItemTotalCents: 0,
          grandTotalCents: 0,
          lineItems: [],
        };
      }
      const rows = await db.engagementQuoteLineItem.findMany({
        where: { engagementQuoteId: quote.id },
        orderBy: { position: 'asc' },
      });
      const baseTotal = Number(quote.baseTotalCents);
      // Recompute percentage rows against the LIVE base so the per-line amount the
      // UI shows ("10% off → −₹10,000") and the total both track a re-quote,
      // instead of showing the stale create-time snapshot.
      const items = rows.map((r) => {
        const dto = toRowDto(r);
        dto.amountCents = effectiveLineItemCents(r, baseTotal);
        return dto;
      });
      const lineItemTotal = items.reduce((sum, r) => sum + r.amountCents, 0);
      const grand = Math.max(0, baseTotal + lineItemTotal);
      return {
        baseTotalCents: baseTotal,
        lineItemTotalCents: lineItemTotal,
        grandTotalCents: grand,
        lineItems: items,
      };
    });
  }

  /**
   * Add a new line item. Two modes:
   *   1. Caller supplies `amountCents` directly. We trust it.
   *   2. Caller supplies `percentageBps` (basis points) with no
   *      `amountCents`. The service computes the cents from the quote's
   *      current `baseTotalCents` and stamps it. The percentage is
   *      preserved on the row so the UI can show "10% off" instead of
   *      a bare cents number.
   *
   * Discount semantics:
   *   - `kind='discount'` rows should be negative cents.
   *   - We coerce sign here for safety: if the reviewer enters a
   *     positive `amountCents` on a discount, we flip the sign.
   */
  async create(
    tenantId: string,
    engagementId: string,
    input: CreateQuoteLineItemInput,
    actorUserId: string,
  ): Promise<QuoteLineItemRow> {
    if (!QUOTE_LINE_ITEM_KINDS.includes(input.kind)) {
      throw new BadRequestException('bad_kind');
    }
    if (!input.label?.trim()) {
      throw new BadRequestException('label_required');
    }
    if (input.amountCents == null && input.percentageBps == null) {
      throw new BadRequestException('amount_or_percentage_required');
    }
    if (input.percentageBps != null) {
      if (input.percentageBps < -10000 || input.percentageBps > 10000) {
        throw new BadRequestException('percentage_out_of_range');
      }
      if (input.kind !== 'discount') {
        throw new BadRequestException('percentage_only_for_discount');
      }
    }

    return this.tenantDb.run(tenantId, async (db) => {
      const quote = await db.engagementQuote.findUnique({
        where: { engagementId },
        select: { id: true, baseTotalCents: true },
      });
      if (!quote) throw new NotFoundException('quote_not_found');

      // Resolve cents from percentage when applicable.
      let amountCents: number;
      let percentageBps: number | null = input.percentageBps ?? null;
      if (input.percentageBps != null) {
        const base = Number(quote.baseTotalCents);
        // bps / 10000 = fraction. Discounts are negative.
        amountCents = -Math.round((base * Math.abs(input.percentageBps)) / 10_000);
      } else {
        amountCents = Math.round(input.amountCents ?? 0);
        // For discount kind, force negative.
        if (input.kind === 'discount' && amountCents > 0) amountCents = -amountCents;
        // For non-discount kinds, force positive.
        if (input.kind !== 'discount' && amountCents < 0) amountCents = -amountCents;
      }

      const row = await db.engagementQuoteLineItem.create({
        data: {
          tenantId,
          engagementQuoteId: quote.id,
          kind: input.kind,
          label: input.label.trim(),
          amountCents: BigInt(amountCents),
          percentageBps,
          position: input.position ?? 0,
          createdBy: actorUserId,
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'quote_line_item_added',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          lineItemId: row.id,
          kind: row.kind,
          label: row.label,
          amountCents,
        },
      });
      return toRowDto(row);
    });
  }

  async update(
    tenantId: string,
    engagementId: string,
    lineItemId: string,
    input: UpdateQuoteLineItemInput,
    actorUserId: string,
  ): Promise<QuoteLineItemRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementQuoteLineItem.findUnique({
        where: { id: lineItemId },
        include: {
          quote: { select: { id: true, baseTotalCents: true, engagementId: true } },
        },
      });
      if (!existing || existing.quote.engagementId !== engagementId) {
        throw new NotFoundException('line_item_not_found');
      }
      if (input.kind && !QUOTE_LINE_ITEM_KINDS.includes(input.kind)) {
        throw new BadRequestException('bad_kind');
      }
      if (input.percentageBps !== undefined && input.percentageBps !== null) {
        if (input.percentageBps < -10000 || input.percentageBps > 10000) {
          throw new BadRequestException('percentage_out_of_range');
        }
      }

      const nextKind = (input.kind ?? existing.kind) as QuoteLineItemKind;
      let nextAmount = input.amountCents != null
        ? Math.round(input.amountCents)
        : Number(existing.amountCents);
      let nextPct = input.percentageBps !== undefined ? input.percentageBps : existing.percentageBps;
      // Recompute cents from new percentage when the percentage changed.
      if (input.percentageBps !== undefined && input.percentageBps !== null) {
        const base = Number(existing.quote.baseTotalCents);
        nextAmount = -Math.round((base * Math.abs(input.percentageBps)) / 10_000);
      }
      // Sign coercion.
      if (nextKind === 'discount' && nextAmount > 0) nextAmount = -nextAmount;
      if (nextKind !== 'discount' && nextAmount < 0) nextAmount = -nextAmount;

      const updated = await db.engagementQuoteLineItem.update({
        where: { id: lineItemId },
        data: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.label?.trim() ? { label: input.label.trim() } : {}),
          amountCents: BigInt(nextAmount),
          percentageBps: nextPct,
          ...(input.position != null ? { position: input.position } : {}),
          updatedAt: new Date(),
        },
      });
      // Parity with create/remove: emit so a post-approval edit is captured in
      // the thread. The opportunity UI derives "pricing changed since approval"
      // from these events to prompt a re-approval (the approved price + proposal
      // are recomputed only on (re-)approval, not on a bare line-item edit).
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'quote_line_item_updated',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          lineItemId: updated.id,
          kind: updated.kind,
          label: updated.label,
          amountCents: nextAmount,
        },
      });
      return toRowDto(updated);
    });
  }

  async remove(tenantId: string, engagementId: string, lineItemId: string, actorUserId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementQuoteLineItem.findUnique({
        where: { id: lineItemId },
        include: { quote: { select: { engagementId: true } } },
      });
      if (!existing || existing.quote.engagementId !== engagementId) {
        throw new NotFoundException('line_item_not_found');
      }
      await db.engagementQuoteLineItem.delete({ where: { id: lineItemId } });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'quote_line_item_removed',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          lineItemId,
          kind: existing.kind,
          label: existing.label,
          amountCents: Number(existing.amountCents),
        },
      });
    });
  }
}

function toRowDto(r: {
  id: string;
  engagementQuoteId: string;
  kind: string;
  label: string;
  amountCents: bigint;
  percentageBps: number | null;
  position: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): QuoteLineItemRow {
  return {
    id: r.id,
    engagementQuoteId: r.engagementQuoteId,
    kind: r.kind as QuoteLineItemKind,
    label: r.label,
    amountCents: Number(r.amountCents),
    percentageBps: r.percentageBps,
    position: r.position,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
