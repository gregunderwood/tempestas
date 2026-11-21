import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DeviceEntity } from '../devices/models';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';
import { NodeEntity } from './models';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NodeEntity,
      DeviceEntity,
      SensorReadingEntity,
      ZoneEntity,
    ]),
  ],
  controllers: [NodesController],
  providers: [NodesService, { provide: Clock, useClass: SystemClock }],
  exports: [NodesService],
})
export class NodesModule {}
