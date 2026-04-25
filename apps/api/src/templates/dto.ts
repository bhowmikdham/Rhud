import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { NODE_TYPES, TEMPLATE_STATUSES } from '@rhud/shared';
import type { NodeType, TemplateStatus } from '@rhud/shared';

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
}
