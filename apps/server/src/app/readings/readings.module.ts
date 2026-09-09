import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { NodesModule } from '../nodes/nodes.module';
import { ReadingsController } from './readings.controller';
import { ReadingsIngestService } from './readings-ingest.service';
import { ReadingsService } from './readings.service';
import { RetentionService } from './retention.service';
import { SensorReadingEntity } from './models';

@Module({
  imports: [TypeOrmModule.forFeature([SensorReadingEntity]), NodesModule],
  controllers: [ReadingsController],
  providers: [
    ReadingsIngestService,
    ReadingsService,
    RetentionService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [ReadingsIngestService, ReadingsService],
})
export class ReadingsModule {}
