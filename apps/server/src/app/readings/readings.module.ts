import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Clock, SystemClock } from '../common/clock';
import { NodesModule } from '../nodes/nodes.module';
import { ReadingsIngestService } from './readings-ingest.service';
import { SensorReadingEntity } from './models';

/**
 * Ingest only, for now. The query surface - stats, retention, the realtime
 * gateway - lands in phase 6 and builds on the table this fills.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SensorReadingEntity]), NodesModule],
  providers: [ReadingsIngestService, { provide: Clock, useClass: SystemClock }],
  exports: [ReadingsIngestService],
})
export class ReadingsModule {}
