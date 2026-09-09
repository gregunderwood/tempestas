import { Controller, Get } from '@nestjs/common';
import type { HealthReport } from '@tempestas/domain';
import { HealthService } from './health.service';

/** The endpoint you curl at 2am when the greenhouse is cold. */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Always 200, even when degraded. The body carries the verdict and the
   * reasons; a non-200 would make a load balancer or a phone shortcut hide
   * exactly the information somebody is trying to read.
   */
  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
