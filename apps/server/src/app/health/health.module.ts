import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { NodesModule } from '../nodes/nodes.module';
import { SensorReadingEntity } from '../readings/models';
import { RulesModule } from '../rules/rules.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SensorReadingEntity]),
    NodesModule,
    RulesModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, { provide: Clock, useClass: SystemClock }],
})
export class HealthModule {}
