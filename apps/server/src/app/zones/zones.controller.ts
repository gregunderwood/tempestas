import { Controller, Get } from '@nestjs/common';
import type { Zone } from '@tempestas/domain';
import { ZonesService } from './zones.service';

/** GET only. There is no zones write API, and that is a decision, not a gap. */
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  findAll(): Promise<Zone[]> {
    return this.zones.findAll();
  }
}
