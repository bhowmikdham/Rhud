import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TenantPricingConfigService } from './tenant-pricing-config.service.js';

class LoyaltyRuleDto {
  @IsString() @MaxLength(64) tier!: string;
  @IsInt() @Min(0) minLifetimeValueCents!: number;
  @IsNumber() @Min(-0.95) @Max(2) discountPct!: number;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
}

class ManualModifierDto {
  @IsString() @MaxLength(64) name!: string;
  @IsNumber() @Min(0.05) @Max(5) multiplier!: number;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
}

class UpdateTenantPricingConfigDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => LoyaltyRuleDto)
  loyaltyRules?: LoyaltyRuleDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => ManualModifierDto)
  manualModifiers?: ManualModifierDto[];

  @IsOptional() @IsInt() @Min(0) @Max(10000)
  coldStartUntilNClosed?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10000)
  rulesUntilNClosed?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10000)
  linearUntilNClosed?: number;

  @IsOptional() @IsInt() @Min(0) @Max(23)
  retrainHourUtc?: number;
}

/**
 * Per-tenant pricing config — regime thresholds, loyalty rules, manual
 * modifiers, retrain hour. Admin-only writes; reads accessible to any
 * authed tenant user (the approval card needs the threshold values to
 * render the regime pill).
 */
@Controller('tenant/pricing-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantPricingConfigController {
  constructor(private readonly svc: TenantPricingConfigService) {}

  @Get()
  get(@Req() req: AuthedRequest) {
    return this.svc.getOrCreate(req.tenantId);
  }

  @Patch()
  @Roles('admin')
  patch(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateTenantPricingConfigDto,
  ) {
    return this.svc.update(req.tenantId, dto);
  }
}
