import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  LoopConfig,
  NodeOption,
  NextRule,
  NodeType,
  Template,
  TemplateNode,
  TemplateStatus,
  TemplateWithNodes,
} from '@rhud/shared';
import { isNodeType, isTemplateStatus } from '@rhud/shared';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { validateTemplate, type ValidationIssue } from './engine/decision-tree.js';
import type { CreateNodeDto, UpdateNodeDto, CreateTemplateDto, UpdateTemplateDto } from './dto.js';

/**
 * Templates service.
 *
 * Every method accepts a `tenantId` and wraps DB access in `tenantDb.run()`,
 * so RLS enforces cross-tenant isolation at the database layer. The service
 * never holds a tenant-agnostic Prisma handle.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly tenantDb: TenantDb) {}

  // ── Templates ─────────────────────────────────────────────────────────────

  async list(tenantId: string): Promise<Template[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.template.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map(dbTemplateToDomain);
    });
  }

  async getById(tenantId: string, id: string): Promise<TemplateWithNodes> {
    return this.tenantDb.run(tenantId, async (db) => {
      const t = await db.template.findUnique({
        where: { id },
        include: { nodes: { orderBy: { position: 'asc' } } },
      });
      if (!t) throw new NotFoundException('template_not_found');
      return {
        ...dbTemplateToDomain(t),
        nodes: t.nodes.map(dbNodeToDomain),
      };
    });
  }

  async create(tenantId: string, dto: CreateTemplateDto): Promise<Template> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.template.create({
        data: { tenantId, serviceLine: dto.serviceLine, name: dto.name },
      });
      return dbTemplateToDomain(row);
    });
  }

  async update(tenantId: string, id: string, dto: UpdateTemplateDto): Promise<Template> {
    return this.tenantDb.run(tenantId, async (db) => {
      await this.assertExists(db, id);

      // status transitions: draft → published runs validation; published → archived is free.
      if (dto.status) {
        if (!isTemplateStatus(dto.status)) throw new BadRequestException('invalid_status');
        if (dto.status === 'published') {
          const issues = await this.validateLoaded(db, id);
          if (issues.length > 0) {
            throw new BadRequestException({
              code: 'template_invalid',
              issues,
            });
          }
        }
      }

      // rootNodeId, if provided, must belong to this template.
      if (dto.rootNodeId) {
        const found = await db.templateNode.findFirst({
          where: { id: dto.rootNodeId, templateId: id },
          select: { id: true },
        });
        if (!found) throw new BadRequestException('root_node_not_in_template');
      }

      const row = await db.template.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.serviceLine !== undefined ? { serviceLine: dto.serviceLine } : {}),
          ...(dto.rootNodeId !== undefined ? { rootNodeId: dto.rootNodeId } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.rateCardId !== undefined ? { rateCardId: dto.rateCardId } : {}),
        },
      });
      return dbTemplateToDomain(row);
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await this.assertExists(db, id);
      await db.template.delete({ where: { id } });
    });
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────

  async addNode(tenantId: string, templateId: string, dto: CreateNodeDto): Promise<TemplateNode> {
    return this.tenantDb.run(tenantId, async (db) => {
      await this.assertExists(db, templateId);
      if (!isNodeType(dto.nodeType)) throw new BadRequestException('invalid_node_type');

      // Default position to (maxPosition + 1) so fresh nodes append.
      const last = await db.templateNode.findFirst({
        where: { templateId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const position = dto.position ?? (last ? last.position + 1 : 0);

      // Loop body parents must belong to the same template; otherwise
      // we'd silently let an admin nest a node under a different tree.
      if (dto.parentNodeId) {
        const parent = await db.templateNode.findFirst({
          where: { id: dto.parentNodeId, templateId },
          select: { id: true, nodeType: true },
        });
        if (!parent) throw new BadRequestException('parent_not_in_template');
        if (parent.nodeType !== 'loop') throw new BadRequestException('parent_not_a_loop');
      }

      const created = await db.templateNode.create({
        data: {
          templateId,
          tenantId,
          question: dto.question,
          nodeType: dto.nodeType,
          allowFiles: dto.allowFiles ?? false,
          required: dto.required ?? true,
          nextRules: (dto.nextRules ?? []) as unknown as object,
          position,
          ...(dto.options ? { options: dto.options as unknown as object } : {}),
          ...(dto.helpText !== undefined ? { helpText: dto.helpText } : {}),
          ...(dto.placeholder !== undefined ? { placeholder: dto.placeholder } : {}),
          ...(dto.parentNodeId ? { parentNodeId: dto.parentNodeId } : {}),
          ...(dto.loopConfig ? { loopConfig: dto.loopConfig as unknown as object } : {}),
          ...(dto.binding ? { binding: dto.binding as unknown as object } : {}),
        },
      });

      // If this is the first *top-level* node (not a loop body member),
      // set it as the root. Body nodes never become the template root.
      if (!dto.parentNodeId) {
        const rootCheck = await db.template.findUnique({
          where: { id: templateId },
          select: { rootNodeId: true },
        });
        if (rootCheck && !rootCheck.rootNodeId) {
          await db.template.update({ where: { id: templateId }, data: { rootNodeId: created.id } });
        }
      }

      return dbNodeToDomain(created);
    });
  }

  async updateNode(
    tenantId: string,
    templateId: string,
    nodeId: string,
    dto: UpdateNodeDto,
  ): Promise<TemplateNode> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.templateNode.findFirst({
        where: { id: nodeId, templateId },
      });
      if (!existing) throw new NotFoundException('node_not_found');
      if (dto.nodeType && !isNodeType(dto.nodeType)) {
        throw new BadRequestException('invalid_node_type');
      }

      if (dto.parentNodeId !== undefined && dto.parentNodeId !== null) {
        // Validate the new parent: must be in this template, must be a loop,
        // and must not be the node itself (no self-parenting).
        if (dto.parentNodeId === nodeId) {
          throw new BadRequestException('node_cannot_be_its_own_parent');
        }
        const parent = await db.templateNode.findFirst({
          where: { id: dto.parentNodeId, templateId },
          select: { id: true, nodeType: true },
        });
        if (!parent) throw new BadRequestException('parent_not_in_template');
        if (parent.nodeType !== 'loop') throw new BadRequestException('parent_not_a_loop');
      }

      // Use the unchecked update shape — lets us set parentNodeId + loopConfig
      // as scalars rather than going through the relation accessor. Cast
      // is necessary because Prisma's strict-optional discriminator picks
      // the wrong arm of the union otherwise.
      const updateData = {
        ...(dto.question !== undefined ? { question: dto.question } : {}),
        ...(dto.nodeType !== undefined ? { nodeType: dto.nodeType } : {}),
        ...(dto.options !== undefined ? { options: dto.options as unknown as object } : {}),
        ...(dto.allowFiles !== undefined ? { allowFiles: dto.allowFiles } : {}),
        ...(dto.required !== undefined ? { required: dto.required } : {}),
        ...(dto.helpText !== undefined ? { helpText: dto.helpText } : {}),
        ...(dto.placeholder !== undefined ? { placeholder: dto.placeholder } : {}),
        ...(dto.nextRules !== undefined
          ? { nextRules: dto.nextRules as unknown as object }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.parentNodeId !== undefined ? { parentNodeId: dto.parentNodeId } : {}),
        ...(dto.loopConfig !== undefined
          ? { loopConfig: dto.loopConfig as unknown as object | null }
          : {}),
        ...(dto.binding !== undefined
          ? { binding: dto.binding as unknown as object | null }
          : {}),
      };
      const updated = await db.templateNode.update({
        where: { id: nodeId },
        data: updateData as unknown as Parameters<typeof db.templateNode.update>[0]['data'],
      });
      return dbNodeToDomain(updated);
    });
  }

  async removeNode(tenantId: string, templateId: string, nodeId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const found = await db.templateNode.findFirst({
        where: { id: nodeId, templateId },
        select: { id: true },
      });
      if (!found) throw new NotFoundException('node_not_found');

      // If this node is the template's root, clear rootNodeId first
      // (FK is ON DELETE SET NULL but being explicit is kinder to readers).
      await db.template.updateMany({
        where: { id: templateId, rootNodeId: nodeId },
        data: { rootNodeId: null },
      });
      await db.templateNode.delete({ where: { id: nodeId } });
    });
  }

  // ── Bulk import ───────────────────────────────────────────────────────────

  /**
   * Bulk-create nodes from a paste-in payload.
   *
   * Wires the new nodes in order with `always` rules — the first node's
   * default rule points at the second, the second at the third, last at
   * `END`. The first imported node is set as the template root if no root
   * exists (or `replace=true` was passed). This turns an existing
   * questionnaire (Excel/Numbers/CSV) into a working template in one call,
   * which is the dominant onboarding path for the kind of detailed B2B
   * intake forms the cybersecurity/services world uses today.
   */
  async importNodes(
    tenantId: string,
    templateId: string,
    args: {
      replace?: boolean;
      nodes: Array<{
        question: string;
        nodeType: NodeType;
        helpText?: string;
        placeholder?: string;
        required?: boolean;
        options?: NodeOption[];
        allowFiles?: boolean;
      }>;
    },
  ): Promise<{ created: number; rootNodeId: string }> {
    if (args.nodes.length === 0) {
      throw new BadRequestException('no_nodes_to_import');
    }
    return this.tenantDb.run(tenantId, async (db) => {
      await this.assertExists(db, templateId);

      // Optionally wipe everything and reset the root pointer.
      if (args.replace) {
        await db.template.update({
          where: { id: templateId },
          data: { rootNodeId: null },
        });
        await db.templateNode.deleteMany({ where: { templateId } });
      }

      // Position offset: append after whatever's already there.
      const last = await db.templateNode.findFirst({
        where: { templateId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const startPos = last ? last.position + 1 : 0;

      // Pre-allocate UUIDs so we can wire `nextRules` in the same insert
      // batch — avoids a second pass to patch rules with the IDs we just
      // assigned.
      const ids: string[] = args.nodes.map(() => randomUUID());

      // Insert in order; each node's default rule points at the next id,
      // last one terminates with END.
      for (let i = 0; i < args.nodes.length; i++) {
        const node = args.nodes[i]!;
        const nextGoto = i + 1 < args.nodes.length ? ids[i + 1]! : 'END';
        await db.templateNode.create({
          data: {
            id: ids[i]!,
            templateId,
            tenantId,
            question: node.question,
            nodeType: node.nodeType,
            allowFiles: node.allowFiles ?? false,
            required: node.required ?? true,
            position: startPos + i,
            nextRules: ([{ when: { op: 'always' }, goto: nextGoto }]) as unknown as object,
            ...(node.options && node.options.length > 0
              ? { options: node.options as unknown as object }
              : {}),
            ...(node.helpText !== undefined ? { helpText: node.helpText } : {}),
            ...(node.placeholder !== undefined ? { placeholder: node.placeholder } : {}),
          },
        });
      }

      // Ensure the template has a root pointer.
      const tmpl = await db.template.findUniqueOrThrow({
        where: { id: templateId },
        select: { rootNodeId: true },
      });
      const rootNodeId = tmpl.rootNodeId ?? ids[0]!;
      if (!tmpl.rootNodeId) {
        await db.template.update({
          where: { id: templateId },
          data: { rootNodeId: ids[0]! },
        });
      }

      return { created: args.nodes.length, rootNodeId };
    });
  }

  // ── Validation / publish ──────────────────────────────────────────────────

  async validate(tenantId: string, id: string): Promise<ValidationIssue[]> {
    return this.tenantDb.run(tenantId, async (db) => this.validateLoaded(db, id));
  }

  private async validateLoaded(db: PrismaTx, id: string): Promise<ValidationIssue[]> {
    const t = await db.template.findUnique({
      where: { id },
      include: { nodes: { orderBy: { position: 'asc' } } },
    });
    if (!t) throw new NotFoundException('template_not_found');
    return validateTemplate({
      ...dbTemplateToDomain(t),
      nodes: t.nodes.map(dbNodeToDomain),
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async assertExists(db: PrismaTx, id: string): Promise<void> {
    const t = await db.template.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('template_not_found');
  }
}

// ── Domain / Prisma mapping ────────────────────────────────────────────────
// Prisma uses Date objects and Date/JSON columns; the shared types use ISO
// strings and explicit array types. Conversion lives here so every caller
// returns the same shape.

function dbTemplateToDomain(t: {
  id: string;
  tenantId: string;
  serviceLine: string;
  name: string;
  version: number;
  status: string;
  rootNodeId: string | null;
  rateCardId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Template {
  return {
    id: t.id,
    tenantId: t.tenantId,
    serviceLine: t.serviceLine,
    name: t.name,
    version: t.version,
    status: (isTemplateStatus(t.status) ? t.status : 'draft') as TemplateStatus,
    rootNodeId: t.rootNodeId,
    rateCardId: t.rateCardId ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function dbNodeToDomain(n: {
  id: string;
  templateId: string;
  tenantId: string;
  question: string;
  helpText: string | null;
  placeholder: string | null;
  required: boolean;
  nodeType: string;
  options: unknown;
  allowFiles: boolean;
  nextRules: unknown;
  position: number;
  parentNodeId?: string | null;
  loopConfig?: unknown;
  binding?: unknown;
}): TemplateNode {
  return {
    id: n.id,
    templateId: n.templateId,
    tenantId: n.tenantId,
    question: n.question,
    helpText: n.helpText,
    placeholder: n.placeholder,
    required: n.required,
    nodeType: (isNodeType(n.nodeType) ? n.nodeType : 'short_text') as NodeType,
    options: (n.options as NodeOption[] | null) ?? null,
    allowFiles: n.allowFiles,
    nextRules: (n.nextRules as NextRule[]) ?? [],
    position: n.position,
    parentNodeId: n.parentNodeId ?? null,
    loopConfig: (n.loopConfig as LoopConfig | null) ?? null,
    binding: (n.binding as TemplateNode['binding']) ?? null,
  };
}
