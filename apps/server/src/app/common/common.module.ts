import { Global, Module } from '@nestjs/common';
import { DivergenceLog } from './divergence-log';

/**
 * Global because `DivergenceLog` has to be ONE instance: devices records a
 * hardware/database disagreement and health reports it, and two instances would
 * mean health cheerfully reporting no problems while devices holds the evidence.
 */
@Global()
@Module({
  providers: [DivergenceLog],
  exports: [DivergenceLog],
})
export class CommonModule {}
