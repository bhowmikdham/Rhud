/**
 * Lead-management HTTP routes — tickets, follow-ups, AI summary.
 *
 * Routes mounted at both /opportunities/:id/... and /engagements/:id/...
 * to match the existing controller convention (post-rename back-compat).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TicketsService } from './tickets.service.js';
import { FollowUpsService } from './follow-ups.service.js';
import { SummaryService } from './summary.service.js';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '@rhud/shared';

class CreateTicketDto {
  @IsIn(TICKET_CATEGORIES as unknown as string[]) category!: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[]) priority?: string;
  @IsString() @MinLength(1) @MaxLength(280) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsString() raisedBy?: string;
  @IsOptional() @IsString() raisedByEmail?: string;
  @IsOptional() @IsUUID() assignedTo?: string;
}

class UpdateTicketDto {
  @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsIn(TICKET_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsString() @MaxLength(280) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string | null;
  @IsOptional() @IsUUID() assignedTo?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) resolutionNote?: string | null;
}

class CreateFollowUpDto {
  @IsISO8601() scheduledFor!: string;
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
  @IsOptional() @IsUUID() assignedTo?: string;
  @IsOptional() @IsUUID() relatedTicketId?: string;
}

class UpdateFollowUpDto {
  @IsOptional() @IsISO8601() scheduledFor?: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @IsUUID() assignedTo?: string | null;
  @IsOptional() @IsUUID() relatedTicketId?: string | null;
}

class CompleteFollowUpDto {
  @IsOptional() @IsString() @MaxLength(2000) completionNote?: string;
}

class AcceptManualSummaryDto {
  @IsString() @MinLength(1) @MaxLength(20_000) text!: string;
}

@Controller(['opportunities/:id', 'engagements/:id'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadManagementController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly followUps: FollowUpsService,
    private readonly summary: SummaryService,
  ) {}

  // ── Tickets ────────────────────────────────────────────────────────

  @Get('tickets')
  listTickets(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    return this.tickets.list(req.tenantId, engagementId);
  }

  @Post('tickets')
  createTicket(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Body() dto: CreateTicketDto,
  ) {
    return this.tickets.create(req.tenantId, engagementId, dto as Parameters<TicketsService['create']>[2], {
      userId: req.user.sub,
      role: req.user.role,
      email: req.user.email,
    });
  }

  @Patch('tickets/:ticketId')
  updateTicket(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.tickets.update(
      req.tenantId,
      engagementId,
      ticketId,
      dto as Parameters<TicketsService['update']>[3],
      req.user.sub,
    );
  }

  @Delete('tickets/:ticketId')
  @HttpCode(204)
  async removeTicket(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Param('ticketId') ticketId: string,
  ) {
    await this.tickets.remove(req.tenantId, engagementId, ticketId, req.user.role);
  }

  // ── Follow-ups ─────────────────────────────────────────────────────

  @Get('follow-ups')
  listFollowUps(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    return this.followUps.list(req.tenantId, engagementId);
  }

  @Post('follow-ups')
  createFollowUp(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Body() dto: CreateFollowUpDto,
  ) {
    return this.followUps.create(req.tenantId, engagementId, dto, req.user.sub);
  }

  @Patch('follow-ups/:followUpId')
  updateFollowUp(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Param('followUpId') followUpId: string,
    @Body() dto: UpdateFollowUpDto,
  ) {
    return this.followUps.update(req.tenantId, engagementId, followUpId, dto);
  }

  @Post('follow-ups/:followUpId/complete')
  completeFollowUp(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Param('followUpId') followUpId: string,
    @Body() dto: CompleteFollowUpDto,
  ) {
    return this.followUps.complete(req.tenantId, engagementId, followUpId, dto, req.user.sub);
  }

  @Delete('follow-ups/:followUpId')
  @HttpCode(204)
  async removeFollowUp(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Param('followUpId') followUpId: string,
  ) {
    await this.followUps.remove(req.tenantId, engagementId, followUpId);
  }

  // ── AI summary ─────────────────────────────────────────────────────

  @Get('summary')
  getSummary(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    return this.summary.getCurrent(req.tenantId, engagementId);
  }

  @Post('summary')
  generateSummary(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    return this.summary.generate(req.tenantId, engagementId, req.user.sub);
  }

  /**
   * Auto path. Called by the web UI on opportunity page load. Fast
   * path that returns the cached summary unchanged when the activity
   * chain hasn't moved; only invokes the LLM when the chain has new
   * events since the last generation.
   */
  @Post('summary/auto')
  autoGenerateSummary(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    return this.summary.generateIfStale(req.tenantId, engagementId, req.user.sub);
  }

  @Post('summary/manual')
  acceptManualSummary(
    @Req() req: AuthedRequest,
    @Param('id') engagementId: string,
    @Body() dto: AcceptManualSummaryDto,
  ) {
    return this.summary.acceptManual(req.tenantId, engagementId, dto, req.user.sub);
  }

  @Delete('summary')
  @HttpCode(204)
  async clearSummary(@Req() req: AuthedRequest, @Param('id') engagementId: string) {
    await this.summary.clear(req.tenantId, engagementId);
  }
}

// ── Manager dashboard ────────────────────────────────────────────────

@Controller('tenant/lead-management')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadManagementDashboardController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly followUps: FollowUpsService,
  ) {}

  /** Open + in-progress tickets across the tenant. Surfaces in the
   *  manager dashboard "Tickets needing attention" widget. */
  @Get('open-tickets')
  @Roles('admin', 'sales_manager')
  openTickets(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.tickets.listOpenForTenant(req.tenantId, limit ? Number(limit) : undefined);
  }

  /** Pending follow-ups due in the next N days (default 14). Overdue
   *  ones come first. */
  @Get('upcoming-follow-ups')
  @Roles('admin', 'sales_manager', 'sales_employee')
  upcomingFollowUps(
    @Req() req: AuthedRequest,
    @Query('within') within?: string,
    @Query('limit') limit?: string,
  ) {
    return this.followUps.listUpcomingForTenant(req.tenantId, {
      ...(within ? { withinDays: Number(within) } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }
}
