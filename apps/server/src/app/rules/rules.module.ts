import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DevicesModule } from '../devices/devices.module';
import { NodesModule } from '../nodes/nodes.module';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ZoneEntity, SensorReadingEntity]),
    DevicesModule,
    NodesModule,
  ],
  controllers: [RulesController],
  providers: [RulesService, { provide: Clock, useClass: SystemClock }],
  exports: [RulesService],
})
export class RulesModule {}
