import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakeHardwareService } from './fake-hardware.service';
import { HardwareService } from './hardware.service';

/**
 * HARDWARE_DRIVER=fake|mqtt is the seam that lets phases 1-6 be built and
 * verified with no node, no sidecar and no relays. It is deliberately here from
 * the first commit of this module rather than retrofitted, and `fake` stays the
 * default for local development on a laptop forever.
 */
const hardwareProvider: Provider = {
  provide: HardwareService,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const driver = config.get<string>('HARDWARE_DRIVER', 'fake');
    if (driver === 'fake') {
      // Deliberately NOT started here: it announces its nodes from
      // onApplicationBootstrap, once the registry has subscribed. See the
      // comment on FakeHardwareService.onApplicationBootstrap.
      return new FakeHardwareService();
    }
    // MqttHardwareService lands in phase 7. Failing loudly beats silently
    // falling back to a simulator on a box that controls a burner.
    throw new Error(
      `HARDWARE_DRIVER="${driver}" is not implemented yet; only "fake" is available.`,
    );
  },
};

@Global()
@Module({
  providers: [hardwareProvider],
  exports: [HardwareService],
})
export class HardwareModule {}
