import { Controller, Get, Query } from '@nestjs/common';
import type {
  EquipmentRuntimeReport,
  FreezeMarginReport,
} from '@tempestas/domain';
import { EquipmentRuntimeQueryDto } from './dto/equipment-runtime-query.dto';
import { FreezeMarginQueryDto } from './dto/freeze-margin-query.dto';
import { FreezeMarginService } from './freeze-margin.service';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly freezeMargin: FreezeMarginService,
  ) {}

  @Get('equipment-runtime')
  buildEquipmentRuntime(
    @Query() query: EquipmentRuntimeQueryDto,
  ): Promise<EquipmentRuntimeReport> {
    return this.reports.buildEquipmentRuntime(query);
  }

  @Get('freeze-margin')
  buildFreezeMargin(
    @Query() query: FreezeMarginQueryDto,
  ): Promise<FreezeMarginReport> {
    return this.freezeMargin.buildFreezeMargin(query);
  }
}
