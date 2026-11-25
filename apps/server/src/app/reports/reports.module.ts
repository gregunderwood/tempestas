import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import { NodesModule } from '../nodes/nodes.module';
import { ReadingsModule } from '../readings/readings.module';
import { ZoneEntity } from '../zones/models';
import { FreezeMarginService } from './freeze-margin.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { TimeInRangeService } from './time-in-range.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ZoneEntity, DeviceEntity, PinTransitionEntity]),
    NodesModule,
    ReadingsModule,
  ],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    FreezeMarginService,
    TimeInRangeService,
    { provide: Clock, useClass: SystemClock },
  ],
})
export class ReportsModule {}
