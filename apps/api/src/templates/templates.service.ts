import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type {
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

      const created = await db.templateNode.create({
        data: {
          templateId,
          tenantId,
          question: dto.question,
          nodeType: dto.nodeType,
          allowFiles: dto.allowFiles ?? false,
          nextRules: (dto.nextRules ?? []) as unknown as object,
          position,
          ...(dto.options ? { options: dto.options as unknown as object } : {}),
        },
      });

      // If this is the first node, set it as the root.
      const rootCheck = await db.template.findUnique({
        where: { id: templateId },
        select: { rootNodeId: true },
      });
      if (rootCheck && !rootCheck.rootNodeId) {
        await db.template.update({ where: { id: templateId }, data: { rootNodeId: created.id } });
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

      const updated = await db.templateNode.update({
        where: { id: nodeId },
        data: {
          ...(dto.question !== undefined ? { question: dto.question } : {}),
          ...(dto.nodeType !== undefined ? { nodeType: dto.nodeType } : {}),
          ...(dto.options !== undefined ? { options: dto.options as unknown as object } : {}),
          ...(dto.allowFiles !== undefined ? { allowFiles: dto.allowFiles } : {}),
          ...(dto.nextRules !== undefined
            ? { nextRules: dto.nextRules as unknown as object }
            : {}),
          ...(dto.position !== undefined ? { position: dto.position } : {}),
        },
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
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function dbNodeToDomain(n: {
  id: string;
  templateId: string;
  tenantId: string;
  question: string;
  nodeType: string;
  options: unknown;
  allowFiles: boolean;
  nextRules: unknown;
  position: number;
}): TemplateNode {
  return {
    id: n.id,
    templateId: n.templateId,
    tenantId: n.tenantId,
    question: n.question,
    nodeType: (isNodeType(n.nodeType) ? n.nodeType : 'short_text') as NodeType,
    options: (n.options as NodeOption[] | null) ?? null,
    allowFiles: n.allowFiles,
    nextRules: (n.nextRules as NextRule[]) ?? [],
    position: n.position,
  };
}
