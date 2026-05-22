/**
 * Phase D — DOCX proposal renderer.
 *
 * Takes an engagement, its quote, its line items, and the tenant's
 * `proposal_defaults` boilerplate. Builds a Word document via docx-js
 * with the sections the PM doc lists:
 *
 *   Cover page         — client name + contact + tagline
 *   Executive summary  — LLM-generated proposal_draft (if present) or
 *                        an auto-built abstract
 *   Scope of work      — engagement name + categorised description
 *   Methodology        — tenant default, keyed by category slug
 *   Deliverables       — template's deliverables or fallback prose
 *   Tools              — tenant default, keyed by category slug
 *   Timelines          — engagement.deliveryTimelineOverride or default
 *   Team details       — tenant default
 *   Commercials        — quote breakdown + line items table
 *   Assumptions        — engagement.assumptions
 *   Exclusions         — engagement.exclusions
 *   Terms & conditions — tenant default
 *
 * The renderer is pure: no LLM calls at render time. We expect
 * proposal_draft to already be populated (the existing flow generates
 * it via LLM). Empty sections degrade gracefully — they're skipped
 * with a "—" placeholder.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { TenantDb } from '../db/with-tenant.js';
import type { ProposalDefaults } from '@rhud/shared';

export interface RenderedProposal {
  /** docx bytes ready to stream. */
  buffer: Buffer;
  /** Suggested filename (without path), e.g. "Proposal - Acme Q3.docx". */
  filename: string;
}

@Injectable()
export class ProposalDocxService {
  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * Build the DOCX for an engagement and return the bytes.
   * Throws 404 if the engagement doesn't exist.
   */
  async render(tenantId: string, engagementId: string): Promise<RenderedProposal> {
    const ctx = await this.loadContext(tenantId, engagementId);

    const doc = buildDocument(ctx);
    const buffer = await Packer.toBuffer(doc);

    const safeName = (ctx.engagement.name ?? ctx.engagement.clientName ?? 'Proposal')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .slice(0, 80) || 'Proposal';
    const filename = `Proposal - ${safeName}.docx`;
    return { buffer, filename };
  }

  // ── Context loading ──────────────────────────────────────────────

  private async loadContext(tenantId: string, engagementId: string): Promise<RenderContext> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        include: {
          template: { select: { name: true, serviceLine: true } },
          quote: {
            include: {
              lineItems: { orderBy: { position: 'asc' } },
            },
          },
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, proposalDefaults: true },
      });

      // Resolve category name (e.g. 'vapt' → 'VAPT') for the cover.
      let categoryName: string | null = null;
      let subCategoryName: string | null = null;
      if (eng.categorySlug) {
        const cat = await db.opportunityCategory.findFirst({
          where: { slug: eng.categorySlug },
          select: { name: true },
        });
        categoryName = cat?.name ?? eng.categorySlug;
      }
      if (eng.subCategorySlug) {
        const sub = await db.opportunityCategory.findFirst({
          where: { slug: eng.subCategorySlug },
          select: { name: true },
        });
        subCategoryName = sub?.name ?? eng.subCategorySlug;
      }

      const defaults = (tenant?.proposalDefaults ?? {}) as ProposalDefaults;

      return {
        tenant: { name: tenant?.name ?? 'Rhud', defaults },
        engagement: {
          id: eng.id,
          name: eng.name,
          status: eng.status,
          clientEmail: eng.clientEmail,
          clientName: eng.clientName,
          clientAddress: eng.clientAddress,
          contactName: eng.contactName,
          contactPhone: eng.contactPhone,
          serviceLine: eng.template?.serviceLine ?? null,
          templateName: eng.template?.name ?? null,
          categorySlug: eng.categorySlug,
          subCategorySlug: eng.subCategorySlug,
          categoryName,
          subCategoryName,
          assumptions: eng.assumptions,
          exclusions: eng.exclusions,
          deliveryTimelineOverride: eng.deliveryTimelineOverride,
          proposalDraft: eng.proposalDraft,
          createdAt: eng.createdAt,
        },
        quote: eng.quote ? {
          currency: eng.quote.currency,
          baseTotalCents: Number(eng.quote.baseTotalCents),
          approvedPriceCents: eng.quote.approvedPriceCents == null ? null : Number(eng.quote.approvedPriceCents),
          baseBreakdown: eng.quote.baseBreakdown,
          lineItems: eng.quote.lineItems.map((li) => ({
            kind: li.kind,
            label: li.label,
            amountCents: Number(li.amountCents),
            percentageBps: li.percentageBps,
          })),
        } : null,
      };
    });
  }
}

// ── Render context ────────────────────────────────────────────────

interface RenderContext {
  tenant: {
    name: string;
    defaults: ProposalDefaults;
  };
  engagement: {
    id: string;
    name: string | null;
    status: string;
    clientEmail: string;
    clientName: string | null;
    clientAddress: string | null;
    contactName: string | null;
    contactPhone: string | null;
    serviceLine: string | null;
    templateName: string | null;
    categorySlug: string | null;
    subCategorySlug: string | null;
    categoryName: string | null;
    subCategoryName: string | null;
    assumptions: string | null;
    exclusions: string | null;
    deliveryTimelineOverride: string | null;
    proposalDraft: string | null;
    createdAt: Date;
  };
  quote: {
    currency: string;
    baseTotalCents: number;
    approvedPriceCents: number | null;
    baseBreakdown: unknown;
    lineItems: Array<{
      kind: string;
      label: string;
      amountCents: number;
      percentageBps: number | null;
    }>;
  } | null;
}

// ── Document assembly ────────────────────────────────────────────

function buildDocument(ctx: RenderContext): Document {
  const sections = [
    ...coverSection(ctx),
    ...new Array<Paragraph>(),
  ];

  const body: Paragraph[] = [];
  body.push(...coverSection(ctx));
  body.push(pageBreak());

  body.push(heading('Executive summary', 1));
  body.push(...executiveSummary(ctx));

  body.push(heading('Scope of work', 1));
  body.push(...scopeSection(ctx));

  body.push(heading('Methodology', 1));
  body.push(...methodologySection(ctx));

  body.push(heading('Deliverables', 1));
  body.push(...deliverablesSection(ctx));

  body.push(heading('Tools & technologies', 1));
  body.push(...toolsSection(ctx));

  body.push(heading('Timelines', 1));
  body.push(...timelinesSection(ctx));

  body.push(heading('Team', 1));
  body.push(...teamSection(ctx));

  // Commercials uses a Table — needs to live as a sibling in the body.
  return new Document({
    creator: ctx.tenant.name,
    title: `Proposal - ${ctx.engagement.name ?? ctx.engagement.clientName ?? 'Untitled'}`,
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 /* 11pt */ } } },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 32, bold: true, font: 'Arial', color: '111827' },
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 26, bold: true, font: 'Arial', color: '111827' },
          paragraph: { spacing: { before: 240, after: 140 }, outlineLevel: 1 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: [
        ...body,
        // Commercials section is built separately because it includes a Table.
        ...commercialsSection(ctx),
        ...optionalListSection('Assumptions', ctx.engagement.assumptions),
        ...optionalListSection('Exclusions', ctx.engagement.exclusions),
        heading('Terms & conditions', 1),
        ...termsSection(ctx),
      ],
    }],
  });
}

// ── Sections ─────────────────────────────────────────────────────

function coverSection(ctx: RenderContext): Paragraph[] {
  const tagline = ctx.tenant.defaults.coverTagline
    ?? `Proposal for ${ctx.engagement.clientName ?? ctx.engagement.clientEmail}`;
  const dateLabel = ctx.engagement.createdAt.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const out: Paragraph[] = [];
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 2400, after: 240 },
    children: [new TextRun({ text: ctx.tenant.name, bold: true, size: 36 })],
  }));
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 600 },
    children: [new TextRun({ text: tagline, size: 28 })],
  }));
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({
      text: ctx.engagement.name ?? '',
      bold: true, size: 30,
    })],
  }));
  if (ctx.engagement.categoryName) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({
        text: ctx.engagement.subCategoryName
          ? `${ctx.engagement.categoryName} — ${ctx.engagement.subCategoryName}`
          : ctx.engagement.categoryName,
        italics: true, color: '6b7280',
      })],
    }));
  }
  // Client info block
  out.push(...labeledLine('Client', ctx.engagement.clientName ?? '—'));
  if (ctx.engagement.clientAddress) {
    out.push(...labeledLine('Address', ctx.engagement.clientAddress));
  }
  out.push(...labeledLine('Contact', formatContact(ctx)));
  out.push(...labeledLine('Email', ctx.engagement.clientEmail));
  if (ctx.engagement.contactPhone) {
    out.push(...labeledLine('Phone', ctx.engagement.contactPhone));
  }
  out.push(...labeledLine('Date', dateLabel));
  return out;
}

function executiveSummary(ctx: RenderContext): Paragraph[] {
  if (ctx.engagement.proposalDraft?.trim()) {
    return paragraphsFromText(ctx.engagement.proposalDraft);
  }
  // No proposal draft yet → fall back to an auto-built abstract.
  const lines: string[] = [];
  lines.push(
    `${ctx.tenant.name} is pleased to submit this proposal to `
    + `${ctx.engagement.clientName ?? ctx.engagement.clientEmail} for `
    + `${ctx.engagement.categoryName ?? ctx.engagement.serviceLine ?? 'the requested services'}.`,
  );
  if (ctx.engagement.subCategoryName) {
    lines.push(`Scope: ${ctx.engagement.subCategoryName}.`);
  }
  if (ctx.quote?.approvedPriceCents) {
    lines.push(`Proposed engagement value: ${formatCents(ctx.quote.approvedPriceCents, ctx.quote.currency)}.`);
  }
  return paragraphsFromText(lines.join('\n\n'));
}

function scopeSection(ctx: RenderContext): Paragraph[] {
  const out: Paragraph[] = [];
  if (ctx.engagement.name) {
    out.push(new Paragraph({
      children: [
        new TextRun({ text: 'Engagement: ', bold: true }),
        new TextRun({ text: ctx.engagement.name }),
      ],
    }));
  }
  if (ctx.engagement.categoryName) {
    out.push(new Paragraph({
      children: [
        new TextRun({ text: 'Category: ', bold: true }),
        new TextRun({
          text: ctx.engagement.subCategoryName
            ? `${ctx.engagement.categoryName} — ${ctx.engagement.subCategoryName}`
            : ctx.engagement.categoryName,
        }),
      ],
    }));
  }
  if (ctx.engagement.serviceLine) {
    out.push(new Paragraph({
      children: [
        new TextRun({ text: 'Service line: ', bold: true }),
        new TextRun({ text: ctx.engagement.serviceLine }),
      ],
    }));
  }
  // Base breakdown is a JSON of line items — render as bullets when
  // it parses to the expected shape.
  const items = parseBaseBreakdown(ctx.quote?.baseBreakdown);
  if (items.length > 0) {
    out.push(new Paragraph({ spacing: { before: 200 }, children: [
      new TextRun({ text: 'Detailed scope:', bold: true }),
    ]}));
    for (const it of items) {
      out.push(new Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        children: [
          new TextRun({ text: `${it.label}: `, bold: true }),
          new TextRun({ text: `${it.qty}` }),
        ],
      }));
    }
  }
  return out.length > 0 ? out : [paragraph('—')];
}

function methodologySection(ctx: RenderContext): Paragraph[] {
  const key = ctx.engagement.categorySlug;
  const text = key ? ctx.tenant.defaults.methodologyByCategory?.[key] : undefined;
  return text ? paragraphsFromText(text) : [paragraph('Methodology to be confirmed with the client during kickoff.')];
}

function deliverablesSection(_ctx: RenderContext): Paragraph[] {
  // No tenant-defaults field for deliverables — fall back to a
  // sensible cybersec-engagement default. Tenants can override in
  // a follow-up by adding a deliverablesByCategory field.
  return [
    paragraph('• Detailed test plan and methodology document'),
    paragraph('• Executive-summary report (non-technical audience)'),
    paragraph('• Technical findings report with CVSS / severity ratings'),
    paragraph('• Remediation guidance per finding'),
    paragraph('• Closeout call to walk through findings'),
  ];
}

function toolsSection(ctx: RenderContext): Paragraph[] {
  const key = ctx.engagement.categorySlug;
  const text = key ? ctx.tenant.defaults.toolsByCategory?.[key] : undefined;
  return text ? paragraphsFromText(text) : [paragraph('Industry-standard commercial + open-source tooling.')];
}

function timelinesSection(ctx: RenderContext): Paragraph[] {
  const t = ctx.engagement.deliveryTimelineOverride;
  return t ? paragraphsFromText(t) : [paragraph('10 working days from project kickoff, excluding client-side blockers.')];
}

function teamSection(ctx: RenderContext): Paragraph[] {
  const text = ctx.tenant.defaults.teamDetails;
  return text ? paragraphsFromText(text) : [paragraph('Team composition shared on signed engagement.')];
}

function commercialsSection(ctx: RenderContext): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(heading('Commercials', 1));

  if (!ctx.quote) {
    out.push(paragraph('Pricing to be confirmed.'));
    return out;
  }

  // Build a 2-column table: Item | Amount
  const rows: TableRow[] = [];
  rows.push(tableHeader(['Item', 'Amount']));
  rows.push(tableRow([
    'Base price (rate card)',
    formatCents(ctx.quote.baseTotalCents, ctx.quote.currency),
  ]));
  let lineSum = 0;
  for (const li of ctx.quote.lineItems) {
    const label = li.kind === 'discount'
      ? `${li.label}${li.percentageBps != null ? ` (${(li.percentageBps / 100).toFixed(1)}%)` : ''}`
      : `${li.label} (${li.kind})`;
    rows.push(tableRow([
      label,
      formatCents(li.amountCents, ctx.quote.currency),
    ]));
    lineSum += li.amountCents;
  }
  const grand = Math.max(0, ctx.quote.baseTotalCents + lineSum);
  rows.push(tableRow(['Total', formatCents(grand, ctx.quote.currency)], { bold: true }));

  // Insert the table as a Paragraph-shaped container so callers can
  // splice it. docx-js accepts Table at children[] level too.
  // We push it as a "fake" Paragraph for the type — Document accepts
  // Table | Paragraph | TableOfContents at sectionchildren level.
  out.push((new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [6500, 2860],
    rows,
  }) as unknown) as Paragraph);

  if (ctx.quote.approvedPriceCents != null) {
    out.push(new Paragraph({
      spacing: { before: 200 },
      children: [
        new TextRun({ text: 'Approved price: ', bold: true }),
        new TextRun({ text: formatCents(ctx.quote.approvedPriceCents, ctx.quote.currency) }),
      ],
    }));
  }
  return out;
}

function optionalListSection(title: string, text: string | null): Paragraph[] {
  if (!text?.trim()) return [];
  const out: Paragraph[] = [];
  out.push(heading(title, 1));
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    out.push(new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      children: [new TextRun({ text: line })],
    }));
  }
  return out;
}

function termsSection(ctx: RenderContext): Paragraph[] {
  const text = ctx.tenant.defaults.termsConditions;
  return text ? paragraphsFromText(text) : [paragraph('Standard terms & conditions apply.')];
}

// ── Helpers ─────────────────────────────────────────────────────

function heading(text: string, level: 1 | 2): Paragraph {
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    children: [new TextRun(text)],
  });
}

function paragraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function paragraphsFromText(text: string): Paragraph[] {
  return text
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => new Paragraph({ children: [new TextRun({ text: para })] }));
}

function pageBreak(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: '', break: 1 })], pageBreakBefore: true });
}

function labeledLine(label: string, value: string): Paragraph[] {
  return [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: '6b7280' }),
      new TextRun({ text: value }),
    ],
  })];
}

function formatContact(ctx: RenderContext): string {
  const parts: string[] = [];
  if (ctx.engagement.contactName) parts.push(ctx.engagement.contactName);
  if (ctx.engagement.clientName && !ctx.engagement.contactName) parts.push(ctx.engagement.clientName);
  return parts.length ? parts.join(', ') : '—';
}

function formatCents(cents: number, currency: string): string {
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sign = cents < 0 ? '−' : '';
  return `${sign}${currency} ${formatted}`;
}

function tableHeader(labels: string[]): TableRow {
  return new TableRow({
    children: labels.map((l) => new TableCell({
      shading: { fill: 'F3F4F6', type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: l, bold: true })] })],
    })),
  });
}

function tableRow(cells: string[], opts: { bold?: boolean } = {}): TableRow {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'D1D5DB' };
  const borders = { top: border, bottom: border, left: border, right: border };
  return new TableRow({
    children: cells.map((c, i) => new TableCell({
      borders,
      width: { size: i === 0 ? 6500 : 2860, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT,
        children: [new TextRun({ text: c, bold: opts.bold ?? false })],
      })],
    })),
  });
}

function parseBaseBreakdown(raw: unknown): Array<{ label: string; qty: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const obj = r as Record<string, unknown>;
    const label = (obj.serviceLineName ?? obj.label ?? obj.serviceLineSlug);
    const qty = (obj.scopeValue ?? obj.quantity ?? obj.units);
    if (typeof label !== 'string') return [];
    return [{ label, qty: String(qty ?? '') }];
  });
}
