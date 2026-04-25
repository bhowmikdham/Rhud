import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GatheringService } from './gathering.service.js';
import { CreateUploadUrlDto, SubmitAnswerDto } from './dto.js';

/**
 * Client-facing gathering endpoints. NOT prefixed with /api/v1 — they live
 * under the public /g/:token namespace per design doc §4.5. The plaintext
 * token in the URL is the entire authority surface (verified server-side
 * against argon2id hashes).
 */
@Controller('/g/:token')
export class GatheringController {
  constructor(private readonly svc: GatheringService) {}

  @Get('state')
  async getState(@Param('token') token: string, @Req() req: Request) {
    return this.svc.getState(token, ctxFromReq(req));
  }

  @Post('answers')
  @HttpCode(200)
  async submitAnswer(
    @Param('token') token: string,
    @Req() req: Request,
    @Body() dto: SubmitAnswerDto,
  ) {
    return this.svc.submitAnswer(token, ctxFromReq(req), {
      nodeId: dto.nodeId,
      answer: dto.answer as Parameters<GatheringService['submitAnswer']>[2]['answer'],
    });
  }

  @Post('files')
  @HttpCode(200)
  async createUploadUrl(
    @Param('token') token: string,
    @Req() req: Request,
    @Body() dto: CreateUploadUrlDto,
  ) {
    return this.svc.createSignedUploadUrl(token, ctxFromReq(req), dto);
  }

  @Post('submit')
  @HttpCode(200)
  async submit(@Param('token') token: string, @Req() req: Request) {
    return this.svc.submit(token, ctxFromReq(req));
  }
}

function ctxFromReq(req: Request) {
  return {
    ip: (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) || req.ip || '0.0.0.0',
    userAgent: req.headers['user-agent']?.toString() ?? 'unknown',
    acceptLanguage: req.headers['accept-language']?.toString() ?? '',
  };
}
