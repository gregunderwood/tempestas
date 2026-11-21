import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from '../common/clock';
import { RealtimeGateway } from './realtime.gateway';

// Global because ingest, devices and rules all publish to it, and it depends only on a clock.
@Global()
@Module({
  providers: [RealtimeGateway, { provide: Clock, useClass: SystemClock }],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
