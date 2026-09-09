import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { ApiErrorCode, NodeStatus } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { HardwareService } from '../hardware/hardware.service';
import { DevicesService } from './devices.service';
import type { DeviceEntity } from './models';
import type { NodeEntity } from '../nodes/models';

const NOW = new Date('2026-01-10T12:00:00Z');

/** The CO2 generator as actually wired: pin 16, active-LOW, 300s minimum-off. */
function burner(overrides: Partial<DeviceEntity> = {}): DeviceEntity {
  return {
    id: 'dev-1',
    nodeId: 'elantris',
    zoneId: 'zone-1',
    name: 'CO2 Generator',
    description: null,
    gpio: 16,
    onDelayDuration: 300,
    onAt: null,
    offAt: null,
    onLevel: 0,
    rulesEnabled: true,
    role: null,
    node: { id: 'node-uuid', slug: 'elantris', status: NodeStatus.Admitted },
    ...overrides,
  } as DeviceEntity;
}

function makeService(device: DeviceEntity, setPin = vi.fn().mockResolvedValue(undefined)) {
  const save = vi.fn(async (d: DeviceEntity) => d);
  const repo = {
    findOne: vi.fn().mockResolvedValue(device),
    find: vi.fn().mockResolvedValue([device]),
    save,
  } as unknown as Repository<DeviceEntity>;
  const nodeRepo = { findOne: vi.fn() } as unknown as Repository<NodeEntity>;
  const hardware = { setPin, syncPins: vi.fn() } as unknown as HardwareService;
  const service = new DevicesService(repo, nodeRepo, hardware, new FixedClock(NOW));
  return { service, setPin, save };
}

describe('DevicesService interlocks', () => {
  it('turnOn writes the device onLevel exactly once, then persists onAt', async () => {
    const { service, setPin, save } = makeService(burner());
    const dto = await service.turnOn('dev-1');

    expect(setPin).toHaveBeenCalledTimes(1);
    expect(setPin).toHaveBeenCalledWith('elantris', {
      pin: 16,
      level: 0, // active-LOW: 0 energises this relay
      label: 'CO2 Generator',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(dto.onAt).toBe(NOW.toISOString());
    expect(dto.isOn).toBe(true);
  });

  it('turnOff writes the inverse level', async () => {
    const on = burner({ onAt: new Date('2026-01-10T11:00:00Z') });
    const { service, setPin } = makeService(on);
    await service.turnOff('dev-1');
    expect(setPin).toHaveBeenCalledWith(
      'elantris',
      expect.objectContaining({ pin: 16, level: 1 })
    );
  });

  it('refuses to turn on a device that is already on', async () => {
    const { service, setPin } = makeService(burner({ onAt: new Date('2026-01-10T11:00:00Z') }));
    await expect(service.turnOn('dev-1')).rejects.toBeInstanceOf(ConflictException);
    expect(setPin).not.toHaveBeenCalled();
  });

  it('refuses to turn off a device that is already off', async () => {
    const { service, setPin } = makeService(burner());
    await expect(service.turnOff('dev-1')).rejects.toBeInstanceOf(ConflictException);
    expect(setPin).not.toHaveBeenCalled();
  });

  // The interlock has to hold for the in-process caller (the rules engine),
  // which is the entire reason the Python version went over loopback HTTP.
  it('refuses during the cooldown and publishes NOTHING', async () => {
    const cooling = burner({
      onAt: new Date('2026-01-10T11:00:00Z'),
      offAt: new Date('2026-01-10T11:59:00Z'), // 60s ago, 300s delay
    });
    const { service, setPin, save } = makeService(cooling);

    await expect(service.turnOn('dev-1')).rejects.toMatchObject({
      response: { code: ApiErrorCode.DeviceCooldown },
    });
    expect(setPin).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports canTurnOnAt so the UI can disable the button instead of failing', async () => {
    const cooling = burner({
      onAt: new Date('2026-01-10T11:00:00Z'),
      offAt: new Date('2026-01-10T11:59:00Z'),
    });
    const { service } = makeService(cooling);
    const dto = await service.findOne('dev-1');
    expect(dto.canTurnOn).toBe(false);
    expect(dto.canTurnOnAt).toBe('2026-01-10T12:04:00.000Z');
  });

  it('forceOn bypasses the cooldown', async () => {
    const cooling = burner({
      onAt: new Date('2026-01-10T11:00:00Z'),
      offAt: new Date('2026-01-10T11:59:00Z'),
    });
    const { service, setPin } = makeService(cooling);
    await expect(service.forceOn('dev-1')).resolves.toMatchObject({ isOn: true });
    expect(setPin).toHaveBeenCalledTimes(1);
  });

  it('forceOn still refuses a device that is already on', async () => {
    const { service, setPin } = makeService(burner({ onAt: new Date('2026-01-10T11:00:00Z') }));
    await expect(service.forceOn('dev-1')).rejects.toBeInstanceOf(ConflictException);
    expect(setPin).not.toHaveBeenCalled();
  });

  // A pending node is inert in BOTH directions: its readings are discarded on
  // the way in, and it is refused commands on the way out. Otherwise a stray
  // ESP32 could be handed a burner relay before anyone admitted it.
  it('refuses to command a device on a node that is not admitted', async () => {
    const onPending = burner({
      node: { id: 'node-uuid', slug: 'ghost', status: NodeStatus.Pending },
    } as Partial<DeviceEntity>);
    const { service, setPin, save } = makeService(onPending);

    await expect(service.turnOn('dev-1')).rejects.toMatchObject({
      response: { code: ApiErrorCode.NodeNotAdmitted },
    });
    expect(setPin).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to command a device on a disabled node, even with force-on', async () => {
    const onDisabled = burner({
      node: { id: 'node-uuid', slug: 'rejected', status: NodeStatus.Disabled },
    } as Partial<DeviceEntity>);
    const { service, setPin } = makeService(onDisabled);

    await expect(service.forceOn('dev-1')).rejects.toMatchObject({
      response: { code: ApiErrorCode.NodeNotAdmitted },
    });
    expect(setPin).not.toHaveBeenCalled();
  });

  // The old system logged the GPIO failure and updated the row anyway, so the
  // database drifted from the hardware and the UI lied about the heater.
  it('does NOT persist state when the hardware write fails', async () => {
    const setPin = vi.fn().mockRejectedValue(new Error('READBACK_MISMATCH'));
    const { service, save } = makeService(burner(), setPin);

    await expect(service.turnOn('dev-1')).rejects.toThrow('READBACK_MISMATCH');
    expect(save).not.toHaveBeenCalled();
  });
});
