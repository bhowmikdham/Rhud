import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { NODE_TYPES, TEMPLATE_STATUSES } from '@rhud/shared';
import type { LoopConfig, NodeBinding, NodeType, TemplateStatus } from '@rhud/shared';

// ── Template create / update ────────────────────────────────────────────────

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  serviceLine!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  serviceLine?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsUUID()
  rootNodeId?: string;

  @IsOptional()
  @IsIn(TEMPLATE_STATUSES as unknown as string[])
  status?: TemplateStatus;

  @IsOptional()
  @IsUUID()
  rateCardId?: string | null;

  /** Gamma template id forwarded to Gamma when proposal drafting is
   *  routed through the Gamma driver. Free-form string — Gamma's id
   *  format isn't a UUID and varies by API revision. Empty string or
   *  null clears the binding. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  gammaTemplateId?: string | null;

  /** Markdown proposal scaffold with `{{token}}` merge fields. Empty
   *  string or null clears it (reverts to AI-generates-everything). */
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  proposalScaffold?: string | null;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

export class NodeOptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  value!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  desc?: string;
}

/**
 * NextRule is validated structurally rather than through class-validator.
 * The engine's `validateTemplate()` catches semantic issues (dangling gotos,
 * etc.) when the template is published; per-rule shape is loose here.
 */
export class CreateNodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;

  @IsIn(NODE_TYPES as unknown as string[])
  nodeType!: NodeType;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  helpText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NodeOptionDto)
  @ArrayMinSize(1)
  options?: NodeOptionDto[];

  @IsOptional()
  @IsBoolean()
  allowFiles?: boolean;

  // next_rules validated as opaque JSON — the engine checks semantics.
  @IsOptional()
  @IsArray()
  nextRules?: Array<{ when: { op: string; value?: unknown }; goto: string }>;

  @IsOptional()
  @IsInt()
  position?: number;

  @IsOptional()
  @IsUUID()
  parentNodeId?: string;

  @IsOptional()
  @IsObject()
  loopConfig?: LoopConfig;

  @IsOptional()
  @IsObject()
  binding?: NodeBinding;
}

export class UpdateNodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsIn(NODE_TYPES as unknown as string[])
  nodeType?: NodeType;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  helpText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NodeOptionDto)
  options?: NodeOptionDto[];

  @IsOptional()
  @IsBoolean()
  allowFiles?: boolean;

  @IsOptional()
  @IsArray()
  nextRules?: Array<{ when: { op: string; value?: unknown }; goto: string }>;

  @IsOptional()
  @IsInt()
  position?: number;

  @IsOptional()
  @IsUUID()
  parentNodeId?: string | null;

  @IsOptional()
  @IsObject()
  loopConfig?: LoopConfig | null;

  @IsOptional()
  @IsObject()
  binding?: NodeBinding | null;
}

// ── Bulk import ─────────────────────────────────────────────────────────────

export class ImportNodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;

  @IsIn(NODE_TYPES as unknown as string[])
  nodeType!: NodeType;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  helpText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NodeOptionDto)
  options?: NodeOptionDto[];

  @IsOptional()
  @IsBoolean()
  allowFiles?: boolean;
}

export class ImportNodesDto {
  /**
   * Wipe existing nodes before importing? Default false (append).
   * If true and the template has a rootNodeId, the root is cleared too.
   */
  @IsOptional()
  @IsBoolean()
  replace?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportNodeDto)
  nodes!: ImportNodeDto[];
}
