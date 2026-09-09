import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Global because three unrelated modules publish to it - ingest, devices and
 * rules - and the alternative is threading the same provider through every
 * module's imports. It exports one class that depends on nothing, so there is
 * no cycle to create.
 */
@Global()
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
