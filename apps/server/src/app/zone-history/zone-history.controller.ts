import { Controller, Get } from '@nestjs/common';
import type { ZoneHistoryReport } from '@tempestas/domain';
import { ZoneHistoryService } from './zone-history.service';

@Controller('zone-history')
export class ZoneHistoryController {
  constructor(private readonly zoneHistory: ZoneHistoryService) {}

  @Get()
  buildZoneHistory(): Promise<ZoneHistoryReport> {
    return this.zoneHistory.buildZoneHistory();
  }
}
