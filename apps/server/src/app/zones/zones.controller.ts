import { Controller, Get } from '@nestjs/common';
import type { Zone } from '@tempestas/domain';
import { ZonesService } from './zones.service';

/** Read-only on purpose: zone rules drive heaters and change only through reviewed SQL. */
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  findAll(): Promise<Zone[]> {
    return this.zones.findAll();
  }
}
