import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceEntity, PinTransitionEntity } from './models';
import { NodeEntity } from '../nodes/models';
import { PinTransitionLog } from './pin-transition-log.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity, NodeEntity, PinTransitionEntity])],
  controllers: [DevicesController],
  providers: [DevicesService, PinTransitionLog, { provide: Clock, useClass: SystemClock }],
  exports: [DevicesService, PinTransitionLog],
})
export class DevicesModule {}
