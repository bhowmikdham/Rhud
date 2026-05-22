/**
 * Phase A — HTTP endpoints for additional quote line items.
 *
 *   GET    /opportunities/:id/quote/line-items
 *   POST   /opportunities/:id/quote/line-items
 *   PATCH  /opportunities/:id/quote/line-items/:itemId
 *   DELETE /opportunities/:id/quote/line-items/:itemId
 *
 * Reads are open to all authed roles in the tenant; mutations are
 * gated to reviewer+ (manager, admin, tech_team).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { QuoteLineItemsService } from './quote-line-items.service.js';
import { QUOTE_LINE_ITEM_KINDS } from '@rhud/shared';

class CreateLineItemDto {
  @IsIn(QUOTE_LINE_ITEM_KINDS as unknown as string[]) kind!: string;
  @IsString() @MinLength(1) @MaxLength(280) label!: string;
  @IsOptional() @IsInt() amountCents?: number;
  @IsOptional() @IsInt() @Min(-10000) percentageBps?: number;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

class UpdateLineItemDto {
  @IsOptional() @IsIn(QUOTE_LINE_ITEM_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsString() @MaxLength(280) label?: string;
  @IsOptional() @IsInt() amountCents?: number;
  @IsOptional() @IsInt() percentageBps?: number | null;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

@Controller(['opportunities/:id/quote/line-items', 'engagements/:id/quote/line-items'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuoteLineItemsController {
  constructor(private readonly svc: QuoteLineItemsService) {}

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.getBreakdown(req.tenantId, engagementId);
  }

  @Post()
  @Roles('admin', 'sales_manager', 'tech_team')
  create(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: CreateLineItemDto,
  ) {
    return this.svc.create(req.tenantId, engagementId, dto as Parameters<QuoteLineItemsService['create']>[2], req.user.sub);
  }

  @Patch(':itemId')
  @Roles('admin', 'sales_manager', 'tech_team')
  update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateLineItemDto,
  ) {
    return this.svc.update(req.tenantId, engagementId, itemId, dto as Parameters<QuoteLineItemsService['update']>[3]);
  }

  @Delete(':itemId')
  @Roles('admin', 'sales_manager', 'tech_team')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    await this.svc.remove(req.tenantId, engagementId, itemId, req.user.sub);
  }
}
