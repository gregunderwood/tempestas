import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, SystemClock } from '../common/clock';
import { FakeHardwareService } from './fake-hardware.service';
import { HardwareService } from './hardware.service';
import { MqttHardwareService } from './mqtt-hardware.service';

/**
 * HARDWARE_DRIVER=fake|mqtt is the seam that lets phases 1-6 be built and
 * verified with no node, no sidecar and no relays. It is deliberately here from
 * the first commit of this module rather than retrofitted, and `fake` stays the
 * default for local development on a laptop forever.
 */
const hardwareProvider: Provider = {
  provide: HardwareService,
  inject: [ConfigService, Clock],
  useFactory: (config: ConfigService, clock: Clock) => {
    const driver = config.get<string>('HARDWARE_DRIVER', 'fake');
    if (driver === 'fake') {
      // Deliberately NOT started here: it announces its nodes from
      // onApplicationBootstrap, once the registry has subscribed. See the
      // comment on FakeHardwareService.onApplicationBootstrap.
      return new FakeHardwareService();
    }
    if (driver === 'mqtt') {
      // Connects from onApplicationBootstrap, for the same reason.
      return new MqttHardwareService(config, clock);
    }
    // Failing loudly beats silently falling back to a simulator on a box that
    // controls a burner.
    throw new Error(
      `HARDWARE_DRIVER="${driver}" is not a driver; use "fake" or "mqtt".`,
    );
  },
};

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, hardwareProvider],
  exports: [HardwareService],
})
export class HardwareModule {}
