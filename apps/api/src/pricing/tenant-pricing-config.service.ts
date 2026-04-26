/**
 * Tenant pricing-config service.
 *
 * Loads/upserts the per-tenant TenantPricingConfig row that drives the
 * regime cascade. Defaults are applied via the migration's column
 * defaults — first call upserts a row so the admin always has a real
 * record to PATCH against.
 */

import { Injectable } from '@nestjs/common';
import type {
  LoyaltyRule,
  ManualModifier,
  TenantPricingConfig,
} from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';

export interface PersistedTenantPricingConfig extends TenantPricingConfig {
  tenantId: string;
  updatedAt: string;
}

export interface UpdateTenantPricingConfig {
  loyaltyRules?: LoyaltyRule[];
  manualModifiers?: ManualModifier[];
  coldStartUntilNClosed?: number;
  rulesUntilNClosed?: number;
  linearUntilNClosed?: number;
  retrainHourUtc?: number;
}

@Injectable()
export class TenantPricingConfigService {
  constructor(private readonly tenantDb: TenantDb) {}

  async getOrCreate(tenantId: string): Promise<PersistedTenantPricingConfig> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenantPricingConfig.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      });
      return rowToDomain(row);
    });
  }

  async update(
    tenantId: string,
    patch: UpdateTenantPricingConfig,
  ): Promise<PersistedTenantPricingConfig> {
    return this.tenantDb.run(tenantId, async (db) => {
      // Upsert so PATCH on a fresh tenant Just Works™.
      const row = await db.tenantPricingConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          ...(patch.loyaltyRules !== undefined ? { loyaltyRules: patch.loyaltyRules as unknown as object } : {}),
          ...(patch.manualModifiers !== undefined ? { manualModifiers: patch.manualModifiers as unknown as object } : {}),
          ...(patch.coldStartUntilNClosed !== undefined ? { coldStartUntilNClosed: patch.coldStartUntilNClosed } : {}),
          ...(patch.rulesUntilNClosed !== undefined ? { rulesUntilNClosed: patch.rulesUntilNClosed } : {}),
          ...(patch.linearUntilNClosed !== undefined ? { linearUntilNClosed: patch.linearUntilNClosed } : {}),
          ...(patch.retrainHourUtc !== undefined ? { retrainHourUtc: patch.retrainHourUtc } : {}),
        },
        update: {
          ...(patch.loyaltyRules !== undefined ? { loyaltyRules: patch.loyaltyRules as unknown as object } : {}),
          ...(patch.manualModifiers !== undefined ? { manualModifiers: patch.manualModifiers as unknown as object } : {}),
          ...(patch.coldStartUntilNClosed !== undefined ? { coldStartUntilNClosed: patch.coldStartUntilNClosed } : {}),
          ...(patch.rulesUntilNClosed !== undefined ? { rulesUntilNClosed: patch.rulesUntilNClosed } : {}),
          ...(patch.linearUntilNClosed !== undefined ? { linearUntilNClosed: patch.linearUntilNClosed } : {}),
          ...(patch.retrainHourUtc !== undefined ? { retrainHourUtc: patch.retrainHourUtc } : {}),
          updatedAt: new Date(),
        },
      });
      return rowToDomain(row);
    });
  }
}

interface DbConfig {
  tenantId: string;
  loyaltyRules: unknown;
  manualModifiers: unknown;
  coldStartUntilNClosed: number;
  rulesUntilNClosed: number;
  linearUntilNClosed: number;
  retrainHourUtc: number;
  updatedAt: Date;
}

function rowToDomain(r: DbConfig): PersistedTenantPricingConfig {
  return {
    tenantId: r.tenantId,
    loyaltyRules: (r.loyaltyRules as LoyaltyRule[]) ?? [],
    manualModifiers: (r.manualModifiers as ManualModifier[]) ?? [],
    coldStartUntilNClosed: r.coldStartUntilNClosed,
    rulesUntilNClosed: r.rulesUntilNClosed,
    linearUntilNClosed: r.linearUntilNClosed,
    retrainHourUtc: r.retrainHourUtc,
    updatedAt: r.updatedAt.toISOString(),
  };
}
