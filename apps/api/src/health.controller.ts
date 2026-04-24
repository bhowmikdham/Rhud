import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  status(): { ok: true; service: 'api'; ts: string } {
    return { ok: true, service: 'api', ts: new Date().toISOString() };
  }
}
