import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OutlookService } from './outlook/outlook.service.js';
import { OutlookController } from './outlook/outlook.controller.js';
import { OdooService } from './odoo/odoo.service.js';
import { OdooController } from './odoo/odoo.controller.js';

/**
 * External integrations:
 *   - Outlook: per-user OAuth for sending proposal emails from the rep's
 *     own mailbox.
 *   - Odoo: per-tenant XML-RPC connection for pushing opportunities and
 *     pulling historical data.
 *
 * Each service is exported so other modules (e.g. EngagementsModule) can
 * call them — auto-syncing opportunities to Odoo on lifecycle changes,
 * for instance.
 */
@Module({
  imports: [AuthModule],
  controllers: [OutlookController, OdooController],
  providers: [OutlookService, OdooService],
  exports: [OutlookService, OdooService],
})
export class IntegrationsModule {}
