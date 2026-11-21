import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { NodesModule } from '../nodes/nodes.module';
import { SensorReadingEntity } from '../readings/models';
import { RulesModule } from '../rules/rules.module';
import { ZoneEntity } from '../zones/models';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import {
  readSystemOffsetFromDate,
  SYSTEM_OFFSET_READER,
  TimezoneCheckService,
} from './timezone-check.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SensorReadingEntity, ZoneEntity]),
    NodesModule,
    RulesModule,
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    TimezoneCheckService,
    { provide: Clock, useClass: SystemClock },
    { provide: SYSTEM_OFFSET_READER, useValue: readSystemOffsetFromDate },
  ],
})
export class HealthModule {}
