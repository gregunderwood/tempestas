import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentReleasesModule } from '../agent-releases/agent-releases.module';
import { Clock, SystemClock } from '../common/clock';
import { DeviceEntity } from '../devices/models';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';
import { NodeEntity, NodeUpdateEntity } from './models';
import { NodeUpdatesService } from './node-updates.service';

@Module({
  imports: [
    AgentReleasesModule,
    TypeOrmModule.forFeature([
      NodeEntity,
      NodeUpdateEntity,
      DeviceEntity,
      SensorReadingEntity,
      ZoneEntity,
    ]),
  ],
  controllers: [NodesController],
  providers: [
    NodesService,
    NodeUpdatesService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [NodesService],
})
export class NodesModule {}
