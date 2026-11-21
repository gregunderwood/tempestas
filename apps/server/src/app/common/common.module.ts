import { Global, Module } from '@nestjs/common';
import { DivergenceLog } from './divergence-log';

// Global so devices and health share one DivergenceLog; a second instance would hide the evidence from health.
@Global()
@Module({
  providers: [DivergenceLog],
  exports: [DivergenceLog],
})
export class CommonModule {}
