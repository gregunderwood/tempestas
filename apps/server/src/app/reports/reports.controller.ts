import { Controller, Get, Query } from '@nestjs/common';
import type {
  EquipmentRuntimeReport,
  FreezeMarginReport,
  NodeHealthReport,
} from '@tempestas/domain';
import { EquipmentRuntimeQueryDto } from './dto/equipment-runtime-query.dto';
import { FreezeMarginQueryDto } from './dto/freeze-margin-query.dto';
import { NodeHealthQueryDto } from './dto/node-health-query.dto';
import { FreezeMarginService } from './freeze-margin.service';
import { NodeHealthService } from './node-health.service';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly freezeMargin: FreezeMarginService,
    private readonly nodeHealth: NodeHealthService,
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

  @Get('node-health')
  buildNodeHealth(
    @Query() query: NodeHealthQueryDto,
  ): Promise<NodeHealthReport> {
    return this.nodeHealth.buildNodeHealth(query);
  }
}
