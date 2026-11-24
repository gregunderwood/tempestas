import { Controller, Get, Query } from '@nestjs/common';
import type { EquipmentRuntimeReport } from '@tempestas/domain';
import { EquipmentRuntimeQueryDto } from './dto/equipment-runtime-query.dto';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('equipment-runtime')
  buildEquipmentRuntime(
    @Query() query: EquipmentRuntimeQueryDto,
  ): Promise<EquipmentRuntimeReport> {
    return this.reports.buildEquipmentRuntime(query);
  }
}
