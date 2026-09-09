import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceEntity } from './models';
import { NodeEntity } from '../nodes/models';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity, NodeEntity])],
  controllers: [DevicesController],
  providers: [DevicesService, { provide: Clock, useClass: SystemClock }],
  exports: [DevicesService],
})
export class DevicesModule {}
