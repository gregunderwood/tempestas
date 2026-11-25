import { Controller, Get, Query } from '@nestjs/common';
import type {
  EquipmentRuntimeReport,
  FreezeMarginReport,
  NodeHealthReport,
  TimeInRangeReport,
} from '@tempestas/domain';
import { EquipmentRuntimeQueryDto } from './dto/equipment-runtime-query.dto';
import { FreezeMarginQueryDto } from './dto/freeze-margin-query.dto';
import { NodeHealthQueryDto } from './dto/node-health-query.dto';
import { TimeInRangeQueryDto } from './dto/time-in-range-query.dto';
import { FreezeMarginService } from './freeze-margin.service';
import { NodeHealthService } from './node-health.service';
import { ReportsService } from './reports.service';
import { TimeInRangeService } from './time-in-range.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly freezeMargin: FreezeMarginService,
    private readonly nodeHealth: NodeHealthService,
    private readonly timeInRange: TimeInRangeService,
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

  @Get('time-in-range')
  buildTimeInRange(
    @Query() query: TimeInRangeQueryDto,
  ): Promise<TimeInRangeReport> {
    return this.timeInRange.buildTimeInRange(query);
  }
}
