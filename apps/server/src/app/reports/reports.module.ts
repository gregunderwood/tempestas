import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import { NodesModule } from '../nodes/nodes.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceEntity, PinTransitionEntity]),
    NodesModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService, { provide: Clock, useClass: SystemClock }],
})
export class ReportsModule {}
