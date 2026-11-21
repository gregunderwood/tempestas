import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, SystemClock } from '../common/clock';
import { FakeHardwareService } from './fake-hardware.service';
import { HardwareService } from './hardware.service';
import { MqttHardwareService } from './mqtt-hardware.service';

const DEFAULT_HARDWARE_DRIVER = 'fake';

type DriverFactory = (config: ConfigService, clock: Clock) => HardwareService;

// Neither driver starts here: both wait for onApplicationBootstrap, after the registry subscribes.
const DRIVER_FACTORIES = new Map<string, DriverFactory>([
  ['fake', () => new FakeHardwareService()],
  ['mqtt', (config, clock) => new MqttHardwareService(config, clock)],
]);

const hardwareProvider: Provider = {
  provide: HardwareService,
  inject: [ConfigService, Clock],
  useFactory: (config: ConfigService, clock: Clock) => {
    const driver = config.get<string>(
      'HARDWARE_DRIVER',
      DEFAULT_HARDWARE_DRIVER,
    );
    const createDriver = DRIVER_FACTORIES.get(driver);
    if (!createDriver) {
      // Never fall back to a simulator on a box that controls a burner.
      throw new Error(
        `HARDWARE_DRIVER="${driver}" is not a driver; use "fake" or "mqtt".`,
      );
    }
    return createDriver(config, clock);
  },
};

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, hardwareProvider],
  exports: [HardwareService],
})
export class HardwareModule {}
