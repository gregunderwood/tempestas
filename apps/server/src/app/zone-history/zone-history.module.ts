import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import { NodesModule } from '../nodes/nodes.module';
import { ReadingsModule } from '../readings/readings.module';
import { ZoneEntity } from '../zones/models';
import { ZoneHistoryController } from './zone-history.controller';
import { ZoneHistoryService } from './zone-history.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ZoneEntity, DeviceEntity, PinTransitionEntity]),
    NodesModule,
    ReadingsModule,
  ],
  controllers: [ZoneHistoryController],
  providers: [ZoneHistoryService, { provide: Clock, useClass: SystemClock }],
})
export class ZoneHistoryModule {}
