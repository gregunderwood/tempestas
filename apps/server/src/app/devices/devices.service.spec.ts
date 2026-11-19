import { ConflictException, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { DivergenceLog } from '../common/divergence-log';
import type { PinStateReport } from '../hardware/hardware.service';
import type { Repository } from 'typeorm';
import { ApiErrorCode, DeviceRole, NodeStatus } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import {
  HardwareError,
  type HardwareService,
} from '../hardware/hardware.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
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

/** elantris as it is actually wired: five exposed pins, admitted. */
const NODE = {
  id: 'node-uuid',
  slug: 'elantris',
  status: NodeStatus.Admitted,
  zoneId: 'zone-1',
  capabilities: {
    contractVersion: 1,
    gpio: { pins: [12, 16, 20, 21, 26], supportsReadback: true },
    sensors: [],
    hasRtc: true,
  },
} as NodeEntity;

function makeService(
  device: DeviceEntity,
  setPin = vi.fn().mockResolvedValue(undefined),
  node: NodeEntity | null = NODE,
  lastReport: PinStateReport | null = null,
) {
  const mocks = {
    findOne: vi.fn().mockResolvedValue(device),
    find: vi.fn().mockResolvedValue([device]),
    save: vi.fn(async (d: DeviceEntity) => d),
    remove: vi.fn(async (d: DeviceEntity) => d),
    create: vi.fn(
      (fields: Partial<DeviceEntity>) => ({ ...fields }) as DeviceEntity,
    ),
    nodeFindOne: vi.fn().mockResolvedValue(node),
  };
  const repo = mocks as unknown as Repository<DeviceEntity>;
  const nodeRepo = {
    findOne: mocks.nodeFindOne,
  } as unknown as Repository<NodeEntity>;
  const hardware = {
    setPin,
    syncPins: vi.fn(),
    lastPinReport: vi.fn().mockReturnValue(lastReport),
  } as unknown as HardwareService;
  const publishDeviceState = vi.fn();
  const realtime = { publishDeviceState } as unknown as RealtimeGateway;
  const service = new DevicesService(
    repo,
    nodeRepo,
    hardware,
    new FixedClock(NOW),
    realtime,
  );
  return { service, setPin, save: mocks.save, mocks, publishDeviceState };
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
      expect.objectContaining({ pin: 16, level: 1 }),
    );
  });

  it('refuses to turn on a device that is already on', async () => {
    const { service, setPin } = makeService(
      burner({ onAt: new Date('2026-01-10T11:00:00Z') }),
    );
    await expect(service.turnOn('dev-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(setPin).not.toHaveBeenCalled();
  });

  it('refuses to turn off a device that is already off', async () => {
    const { service, setPin } = makeService(burner());
    await expect(service.turnOff('dev-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
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
    await expect(service.forceOn('dev-1')).resolves.toMatchObject({
      isOn: true,
    });
    expect(setPin).toHaveBeenCalledTimes(1);
  });

  it('forceOn still refuses a device that is already on', async () => {
    const { service, setPin } = makeService(
      burner({ onAt: new Date('2026-01-10T11:00:00Z') }),
    );
    await expect(service.forceOn('dev-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
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

describe('DevicesService lookups', () => {
  it('lists devices with their derived state, never a stored flag', async () => {
    const { service } = makeService(
      burner({ onAt: new Date('2026-01-10T11:00:00Z') }),
    );
    const [dto] = await service.findAll();
    expect(dto).toMatchObject({ id: 'dev-1', nodeId: 'elantris', isOn: true });
  });

  // Rules bind to `role`, not to the display name. The old system resolved
  // devices by name, so renaming one in the UI silently disabled its rule.
  it('looks devices up by zone and role', async () => {
    const { service, mocks } = makeService(burner());
    await service.findByRole('zone-1', DeviceRole.Co2Generator);
    expect(mocks.find).toHaveBeenCalledWith({
      where: { zoneId: 'zone-1', role: DeviceRole.Co2Generator },
      relations: { node: true },
    });
  });

  it('404s an unknown device rather than returning undefined', async () => {
    const { service, mocks } = makeService(burner());
    mocks.findOne.mockResolvedValue(null);
    await expect(service.findOne('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DevicesService.create', () => {
  // `nodeId` on the wire is the node SLUG - the MQTT topic segment - while the
  // FK is the node's uuid. Conflating them addressed a hardware command to a
  // uuid, which is a real bug this repo has already had once.
  it('resolves the node slug to its uuid for the FK', async () => {
    const { service, mocks } = makeService(burner());
    const dto = await service.create({
      nodeId: 'elantris',
      name: 'Extra Relay',
      gpio: 12,
      onDelayDuration: 0,
      onLevel: 0,
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'node-uuid' }),
    );
    expect(dto.nodeId).toBe('elantris');
  });

  it('inherits the zone from the node when the payload omits it', async () => {
    const { service, mocks } = makeService(burner());
    await service.create({
      nodeId: 'elantris',
      name: 'Extra Relay',
      gpio: 12,
      onDelayDuration: 0,
      onLevel: 0,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: 'zone-1' }),
    );
  });

  // A constraint the database cannot express: a device may only claim a pin its
  // node says it exposes. Otherwise a relay is bound to a pin that will never
  // be driven, and it fails silently at actuation time instead of at creation.
  it('refuses a pin the node does not expose, and lists the ones it does', async () => {
    const { service, mocks } = makeService(burner());
    await expect(
      service.create({
        nodeId: 'elantris',
        name: 'Nope',
        gpio: 17,
        onDelayDuration: 0,
        onLevel: 0,
      }),
    ).rejects.toMatchObject({
      response: {
        code: ApiErrorCode.PinNotAvailable,
        details: { availablePins: [12, 16, 20, 21, 26] },
      },
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  // A node reports its pins when it connects, which can be long before the
  // device exists. patji's relays were released (loads ON, by design) while
  // the new rows said off, and every rule tick was answered "already off".
  describe('starts from what the node last reported', () => {
    const extraRelay = {
      nodeId: 'elantris',
      name: 'Extra Relay',
      gpio: 12,
      onDelayDuration: 300,
      onLevel: 1 as const,
    };
    const reported = (
      level: 0 | 1 | null,
      known = level !== null,
    ): PinStateReport => ({
      nodeId: 'elantris',
      pin: 12,
      level,
      known,
      observedAt: new Date(NOW.getTime() - 60_000),
    });

    it('is ON when the pin sits at its onLevel, as of the report', async () => {
      const { service, save } = makeService(
        burner(),
        undefined,
        NODE,
        reported(1),
      );
      const dto = await service.create(extraRelay);
      expect(dto.isOn).toBe(true);
      expect(save.mock.calls[0][0].onAt).toEqual(
        new Date(NOW.getTime() - 60_000),
      );
    });

    it('is off, with no cooldown, when the pin is reported off', async () => {
      const { service } = makeService(burner(), undefined, NODE, reported(0));
      const dto = await service.create(extraRelay);
      expect(dto.isOn).toBe(false);
      expect(dto.canTurnOn).toBe(true);
    });

    it('is off when the level is unknown - unknown is not on either', async () => {
      const { service } = makeService(
        burner(),
        undefined,
        NODE,
        reported(null),
      );
      expect((await service.create(extraRelay)).isOn).toBe(false);
    });

    it('is off when the node has reported nothing', async () => {
      const { service } = makeService(burner());
      expect((await service.create(extraRelay)).isOn).toBe(false);
    });
  });

  it('404s a node slug it has never met', async () => {
    const { service } = makeService(burner(), undefined, null);
    await expect(
      service.create({
        nodeId: 'ghost',
        name: 'Orphan',
        gpio: 16,
        onDelayDuration: 0,
        onLevel: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DevicesService mutations', () => {
  it('updates the editable fields', async () => {
    const { service, save } = makeService(burner());
    const dto = await service.update('dev-1', {
      name: 'Burner',
      onDelayDuration: 600,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(dto).toMatchObject({ name: 'Burner', onDelayDuration: 600 });
  });

  // The manual override. Automation skips the device; REST still drives it.
  it('toggles rulesEnabled without touching the hardware', async () => {
    const { service, setPin } = makeService(burner());
    const dto = await service.setRulesEnabled('dev-1', false);
    expect(dto.rulesEnabled).toBe(false);
    expect(setPin).not.toHaveBeenCalled();
  });

  it('removes a device', async () => {
    const { service, mocks } = makeService(burner());
    await service.remove('dev-1');
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

describe('DevicesService realtime fan-out', () => {
  // Published only after the hardware acknowledged AND the row saved, so the
  // dashboard can never show a state the relay did not reach.
  it('publishes the new state once a write succeeds', async () => {
    const { service, publishDeviceState } = makeService(burner());
    await service.turnOn('dev-1');
    expect(publishDeviceState).toHaveBeenCalledTimes(1);
    expect(publishDeviceState).toHaveBeenCalledWith(
      expect.objectContaining({ isOn: true }),
    );
  });

  it('publishes nothing when the hardware write fails', async () => {
    const setPin = vi.fn().mockRejectedValue(new Error('READBACK_MISMATCH'));
    const { service, publishDeviceState } = makeService(burner(), setPin);
    await expect(service.turnOn('dev-1')).rejects.toThrow();
    expect(publishDeviceState).not.toHaveBeenCalled();
  });

  it('publishes nothing when an interlock refuses', async () => {
    const { service, publishDeviceState } = makeService(
      burner({ onAt: new Date('2026-01-10T11:00:00Z') }),
    );
    await expect(service.turnOn('dev-1')).rejects.toThrow();
    expect(publishDeviceState).not.toHaveBeenCalled();
  });

  it('publishes when a device is handed to or taken from the rules engine', async () => {
    const { service, publishDeviceState } = makeService(burner());
    await service.setRulesEnabled('dev-1', false);
    expect(publishDeviceState).toHaveBeenCalledWith(
      expect.objectContaining({ rulesEnabled: false }),
    );
  });
});

// An offline node, an unacknowledged command and a readback mismatch are
// expected states with distinct remedies. Surfacing them as a bare 500 is the
// exact class of response this project exists to stop producing: the client
// cannot tell "the node is gone" from "the server is broken".
describe('DevicesService hardware failure translation', () => {
  it.each([
    [ApiErrorCode.NodeOffline, 409],
    [ApiErrorCode.ReadbackMismatch, 409],
    [ApiErrorCode.HardwareUnreachable, 503],
  ])('maps %s to HTTP %i with its code intact', async (code, status) => {
    const setPin = vi.fn().mockRejectedValue(new HardwareError(code, 'nope'));
    const { service, save } = makeService(burner(), setPin);

    await expect(service.turnOn('dev-1')).rejects.toMatchObject({
      status,
      response: { code },
    });
    // And, as ever, nothing is persisted when the write did not succeed.
    expect(save).not.toHaveBeenCalled();
  });

  it('lets a genuinely unexpected error propagate untranslated', async () => {
    const setPin = vi
      .fn()
      .mockRejectedValue(new TypeError('undefined is not a function'));
    const { service } = makeService(burner(), setPin);
    await expect(service.turnOn('dev-1')).rejects.toBeInstanceOf(TypeError);
  });
});

/**
 * A commanded change reaches the server twice: once as the node's `gpio/state`,
 * once as `drive()`'s own save. The node answers in milliseconds, so the state
 * report routinely arrives while the row still holds the old value - and
 * reconciliation called that a divergence on every commanded off.
 *
 * Seen live the first time the rules engine cut the burner at 1500 ppm: the
 * DIVERGENCE line was logged one line before the `-> off` that caused it.
 * Harmless to the data, corrosive to the alarm - one that fires every time
 * teaches whoever reads the log to skip the line that matters.
 */
describe('DevicesService reconciliation during its own command', () => {
  const report = (): PinStateReport => ({
    nodeId: NODE.slug,
    pin: burner().gpio,
    // 1 == de-energised on this active-LOW relay.
    level: 1,
    known: true,
    observedAt: NOW,
  });

  /**
   * `onReport` decides WHEN the node speaks. Passing it into `setPin` models
   * the real sequence - the node answers the command in milliseconds, while the
   * server is still awaiting its own save.
   */
  function armed(onReport: 'answers-the-command' | 'unprompted') {
    const pinStates = new Subject<PinStateReport>();
    const setPin = vi.fn(async () => {
      if (onReport === 'answers-the-command') pinStates.next(report());
    });
    const hardware = {
      setPin,
      syncPins: vi.fn(),
      pinStates$: pinStates.asObservable(),
    } as unknown as HardwareService;
    const divergences = new DivergenceLog();
    const repo = {
      // A fresh row each load, as a real repository gives.
      findOne: vi.fn(async () =>
        burner({ onAt: new Date(NOW.getTime() - 60_000), offAt: null }),
      ),
      save: vi.fn(async (d: DeviceEntity) => d),
    } as unknown as Repository<DeviceEntity>;
    const service = new DevicesService(
      repo,
      {
        findOne: vi.fn().mockResolvedValue(NODE),
      } as unknown as Repository<NodeEntity>,
      hardware,
      new FixedClock(NOW),
      { publishDeviceState: vi.fn() } as unknown as RealtimeGateway,
      divergences,
    );
    service.onModuleInit();
    return { service, pinStates, divergences };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('does not call its own command a divergence', async () => {
    const { service, divergences } = armed('answers-the-command');
    await service.turnOff('dev-1');
    await settle();
    expect(divergences.since(new Date(0))).toHaveLength(0);
    service.onModuleDestroy();
  });

  // The guard must not swallow a real one. A report with nothing in flight is
  // the node acting alone - a dead-man trip or a failsafe - which is precisely
  // what the alarm exists for.
  it('still reports a divergence when no command is in flight', async () => {
    const { service, pinStates, divergences } = armed('unprompted');
    pinStates.next(report());
    await settle();
    expect(divergences.since(new Date(0))).toHaveLength(1);
    service.onModuleDestroy();
  });
});
