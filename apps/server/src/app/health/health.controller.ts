import { Controller, Get } from '@nestjs/common';
import type { HealthReport } from '@tempestas/domain';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Always 200, even degraded: a non-200 makes a load balancer or phone shortcut hide the reasons.
  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
