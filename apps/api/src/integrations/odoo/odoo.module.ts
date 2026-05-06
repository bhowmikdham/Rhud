import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { OdooService } from './odoo.service.js';
import { OdooController } from './odoo.controller.js';

/**
 * Odoo Online integration. The DB layer (OdooConnection,
 * OdooFieldMapping, OdooSyncLog, OdooEntityLink, OdooWebhookEvent)
 * lives in the main Prisma schema. This module exposes:
 *   - per-tenant connection config (admin-managed)
 *   - generic CRUD passthrough (admin)
 *   - high-level engagement → opportunity sync (any role with access)
 *   - inbound webhook receiver (auth via shared secret in URL)
 */
@Module({
  imports: [AuthModule],
  controllers: [OdooController],
  providers: [OdooService],
  exports: [OdooService],
})
export class OdooModule {}
