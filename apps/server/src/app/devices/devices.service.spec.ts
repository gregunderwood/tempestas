import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { DivergenceLog } from '../common/divergence-log';
import type { NodeHello, PinStateReport } from '../hardware/hardware.service';
import type { Repository } from 'typeorm';
import {
  ApiErrorCode,
  DeviceRole,
  NodeStatus,
  type NodeCapabilities,
} from '@tempestas/domain';
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
    inputBtuPerHour: null,
    node: { id: 'node-uuid', slug: 'elantris', status: NodeStatus.Admitted },
    ...overrides,
  } as DeviceEntity;
}

const ELANTRIS_CAPABILITIES: NodeCapabilities = {
  contractVersion: 1,
  gpio: { pins: [12, 16, 20, 21, 26], supportsReadback: true },
  sensors: [],
  hasRtc: true,
};

/** elantris as it is actually wired: five exposed pins, admitted. */
const NODE = {
  id: 'node-uuid',
  slug: 'elantris',
  status: NodeStatus.Admitted,
  zoneId: 'zone-1',
  capabilities: ELANTRIS_CAPABILITIES,
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
    findOneBy: vi.fn().mockResolvedValue(null),
    save: vi.fn(async (device: DeviceEntity) => device),
    remove: vi.fn(async (device: DeviceEntity) => device),
    create: vi.fn(
      (fields: Partial<DeviceEntity>) => ({ ...fields }) as DeviceEntity,
    ),
    nodeFindOne: vi.fn().mockResolvedValue(node),
  };
  const deviceRepository = mocks as unknown as Repository<DeviceEntity>;
  const nodeRepository = {
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
    deviceRepository,
    nodeRepository,
    hardware,
    new FixedClock(NOW),
    realtime,
    new DivergenceLog(),
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

  // Must hold for the in-process rules engine, the reason the Python version used loopback HTTP.
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

  // A pending node is inert both ways, so a stray ESP32 cannot be handed a burner relay.
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

  // The old system updated the row anyway, and the UI lied about the heater.
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

  // Rules bind to `role`, so renaming a device cannot silently disable its rule.
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
  // Conflating slug and uuid once addressed a hardware command to a uuid.
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

  it('stores no burner rating unless the payload gives one', async () => {
    const { service, mocks } = makeService(burner());
    const dto = await service.create({
      nodeId: 'elantris',
      name: 'Extra Relay',
      gpio: 12,
      onDelayDuration: 0,
      onLevel: 0,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ inputBtuPerHour: null }),
    );
    expect(dto.inputBtuPerHour).toBeNull();
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

  // Fails at creation rather than silently at actuation time.
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

  // patji's relays were released (loads ON) while the new rows said off.
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
      live: true,
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

  it('sets and clears the burner rating', async () => {
    const { service } = makeService(burner());
    const rated = await service.update('dev-1', { inputBtuPerHour: 40_000 });
    expect(rated.inputBtuPerHour).toBe(40_000);
    const cleared = await service.update('dev-1', { inputBtuPerHour: null });
    expect(cleared.inputBtuPerHour).toBeNull();
  });

  // The manual override. Automation skips the device; REST still drives it.
  it('toggles rulesEnabled without touching the hardware', async () => {
    const { service, setPin } = makeService(burner());
    const dto = await service.setRulesEnabled('dev-1', false);
    expect(dto.rulesEnabled).toBe(false);
    expect(setPin).not.toHaveBeenCalled();
  });

  it('publishes an edit, so every open page shows it', async () => {
    const { service, publishDeviceState } = makeService(burner());
    await service.update('dev-1', { name: 'Burner' });
    expect(publishDeviceState).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Burner' }),
    );
  });

  it('publishes a new device', async () => {
    const { service, publishDeviceState } = makeService(burner());
    await service.create({
      nodeId: 'elantris',
      name: 'Extra Relay',
      gpio: 12,
      onDelayDuration: 0,
      onLevel: 0,
    });
    expect(publishDeviceState).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Extra Relay' }),
    );
  });

  it('removes a device', async () => {
    const { service, mocks } = makeService(burner());
    await service.remove('dev-1');
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

describe('DevicesService remapping a relay', () => {
  const burnerOnElantris = (overrides: Partial<DeviceEntity> = {}) =>
    burner({ node: NODE, ...overrides });
  const runningSince = new Date('2026-01-10T11:00:00Z');

  it.each([
    ['pin', { gpio: 12 }],
    ['on level', { onLevel: 1 as const }],
  ])(
    'refuses to change the %s of a device that is on, and switches nothing',
    async (_change, edit) => {
      const { service, setPin, save } = makeService(
        burnerOnElantris({ onAt: runningSince }),
      );
      await expect(service.update('dev-1', edit)).rejects.toMatchObject({
        response: { code: ApiErrorCode.DeviceAlreadyOn },
      });
      expect(save).not.toHaveBeenCalled();
      expect(setPin).not.toHaveBeenCalled();
    },
  );

  it('lets a device that is on keep its pin and on level while other fields change', async () => {
    const { service } = makeService(burnerOnElantris({ onAt: runningSince }));
    const dto = await service.update('dev-1', {
      name: 'Burner',
      gpio: 16,
      onLevel: 0,
    });
    expect(dto).toMatchObject({ name: 'Burner', isOn: true });
  });

  it('moves a device that is off to another exposed pin without switching anything', async () => {
    const { service, setPin } = makeService(burnerOnElantris());
    const dto = await service.update('dev-1', { gpio: 12 });
    expect(dto.gpio).toBe(12);
    expect(setPin).not.toHaveBeenCalled();
  });

  it('refuses a pin the node does not expose', async () => {
    const { service, save } = makeService(burnerOnElantris());
    await expect(service.update('dev-1', { gpio: 17 })).rejects.toMatchObject({
      response: { code: ApiErrorCode.PinNotAvailable },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a pin another device already uses, and names it', async () => {
    const { service, mocks, save } = makeService(burnerOnElantris());
    mocks.findOneBy.mockResolvedValue({ id: 'dev-2', name: 'Exhaust Fan' });
    await expect(service.update('dev-1', { gpio: 20 })).rejects.toMatchObject({
      response: {
        code: ApiErrorCode.PinNotAvailable,
        message: 'Pin 20 on "elantris" is already used by Exhaust Fan',
      },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to create a device on a pin another device already uses', async () => {
    const { service, mocks, save } = makeService(burner());
    mocks.findOneBy.mockResolvedValue({ id: 'dev-1', name: 'CO2 Generator' });
    await expect(
      service.create({
        nodeId: 'elantris',
        name: 'Second burner',
        gpio: 16,
        onDelayDuration: 0,
        onLevel: 0,
      }),
    ).rejects.toMatchObject({
      response: { code: ApiErrorCode.PinNotAvailable },
    });
    expect(save).not.toHaveBeenCalled();
  });

  // The relay has not moved; only what its level means has.
  it('reads the pin under the new on level straight away', async () => {
    const pinAtHigh: PinStateReport = {
      nodeId: 'elantris',
      pin: 16,
      level: 1,
      known: true,
      observedAt: new Date(NOW.getTime() - 60_000),
      live: true,
    };
    const { service, setPin } = makeService(
      burnerOnElantris(),
      undefined,
      NODE,
      pinAtHigh,
    );
    const dto = await service.update('dev-1', { onLevel: 1 });
    expect(dto.isOn).toBe(true);
    expect(setPin).not.toHaveBeenCalled();
  });

  // After a restart the last report is the retained replay, older than the row's own offAt.
  it.each([
    ['on level', { onLevel: 1 as const }, 16],
    ['pin', { gpio: 12 }, 12],
  ])(
    'reads a retained replay older than the row after a %s change',
    async (_change, edit, reportedPin) => {
      const turnedOffAt = new Date(NOW.getTime() - 60_000);
      const replay: PinStateReport = {
        nodeId: 'elantris',
        pin: reportedPin,
        level: reportedPin === 16 ? 1 : 0,
        known: true,
        observedAt: new Date(turnedOffAt.getTime() - 1_000),
        live: false,
      };
      const { service } = makeService(
        burnerOnElantris({ onAt: runningSince, offAt: turnedOffAt }),
        undefined,
        NODE,
        replay,
      );
      const dto = await service.update('dev-1', edit);
      expect(dto.isOn).toBe(true);
    },
  );

  it('refuses a remap that queued behind a turn-on, and leaves the pin where it is', async () => {
    let storedRow = burnerOnElantris();
    let finishCommand: () => void = () => undefined;
    const slowSetPin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCommand = resolve;
        }),
    );
    const { service, mocks } = makeService(storedRow, slowSetPin);
    mocks.findOne.mockImplementation(async () => ({ ...storedRow }));
    mocks.save.mockImplementation(async (row: DeviceEntity) => {
      storedRow = { ...row };
      return row;
    });

    const turningOn = service.turnOn('dev-1');
    const remapping = service.update('dev-1', { gpio: 12 });
    await vi.waitFor(() => expect(slowSetPin).toHaveBeenCalled());
    finishCommand();

    await expect(turningOn).resolves.toMatchObject({ isOn: true, gpio: 16 });
    await expect(remapping).rejects.toMatchObject({
      response: { code: ApiErrorCode.DeviceAlreadyOn },
    });
    expect(storedRow).toMatchObject({ gpio: 16, onAt: NOW });
  });
});

describe('DevicesService realtime fan-out', () => {
  // Only after the hardware acknowledged and the row saved.
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

// Expected hardware states with distinct remedies must never surface as a bare 500.
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

// Seen live: DIVERGENCE logged one line before the `-> off` that caused it.
describe('DevicesService reconciliation during its own command', () => {
  const report = (): PinStateReport => ({
    nodeId: NODE.slug,
    pin: burner().gpio,
    // 1 == de-energised on this active-LOW relay.
    level: 1,
    known: true,
    observedAt: NOW,
    live: true,
  });

  // `answers-the-command` models the node replying while the server still awaits its save.
  function armed(
    onReport: 'answers-the-command' | 'unprompted',
    storedBootId: string | null = 'boot-1',
  ) {
    const pinStates = new Subject<PinStateReport>();
    const hellos = new Subject<NodeHello>();
    const setPin = vi.fn(async () => {
      if (onReport === 'answers-the-command') pinStates.next(report());
    });
    const hardware = {
      setPin,
      syncPins: vi.fn(),
      pinStates$: pinStates.asObservable(),
      hello$: hellos.asObservable(),
    } as unknown as HardwareService;
    const divergences = new DivergenceLog();
    const deviceRepository = {
      // A fresh row each load, as a real repository gives.
      findOne: vi.fn(async () =>
        burner({ onAt: new Date(NOW.getTime() - 60_000), offAt: null }),
      ),
      save: vi.fn(async (device: DeviceEntity) => device),
    } as unknown as Repository<DeviceEntity>;
    const service = new DevicesService(
      deviceRepository,
      {
        findOne: vi.fn().mockResolvedValue(NODE),
        find: vi.fn().mockResolvedValue([{ ...NODE, bootId: storedBootId }]),
      } as unknown as Repository<NodeEntity>,
      hardware,
      new FixedClock(NOW),
      { publishDeviceState: vi.fn() } as unknown as RealtimeGateway,
      divergences,
    );
    return { service, pinStates, hellos, divergences };
  }

  async function started(...options: Parameters<typeof armed>) {
    const harness = armed(...options);
    await harness.service.onModuleInit();
    return harness;
  }

  function helloFrom(bootId: string): NodeHello {
    return { nodeId: NODE.slug, bootId } as NodeHello;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('does not call its own command a divergence', async () => {
    const { service, divergences } = await started('answers-the-command');
    await service.turnOff('dev-1');
    await settle();
    expect(divergences.since(new Date(0))).toHaveLength(0);
    service.onModuleDestroy();
  });

  // With nothing in flight, the node acted alone: exactly what the alarm is for.
  it('still reports a divergence when no command is in flight', async () => {
    const { service, pinStates, divergences } = await started('unprompted');
    pinStates.next(report());
    await settle();
    expect(divergences.since(new Date(0))).toHaveLength(1);
    service.onModuleDestroy();
  });

  // An agent claims its fail-safe level as it starts: docs/Safety.md 3c.
  describe('after the node restarts', () => {
    const recorded = (divergences: DivergenceLog) =>
      divergences.since(new Date(0));

    it('explains the first report after a new boot and warns rather than errs', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const error = vi.spyOn(Logger.prototype, 'error');
      const { service, pinStates, hellos, divergences } =
        await started('unprompted');
      hellos.next(helloFrom('boot-2'));
      pinStates.next(report());
      await settle();
      expect(recorded(divergences)).toMatchObject([
        { isExplainedByReboot: true },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('restarted and claimed its fail-safe level'),
      );
      expect(error).not.toHaveBeenCalled();
      service.onModuleDestroy();
      warn.mockRestore();
      error.mockRestore();
    });

    it('explains only the first report for each pin', async () => {
      const { service, pinStates, hellos, divergences } =
        await started('unprompted');
      hellos.next(helloFrom('boot-2'));
      pinStates.next(report());
      pinStates.next(report());
      await settle();
      expect(
        recorded(divergences).map((entry) => entry.isExplainedByReboot),
      ).toEqual([true, false]);
      service.onModuleDestroy();
    });

    it('does not explain a report after a hello from the same boot', async () => {
      const { service, pinStates, hellos, divergences } =
        await started('unprompted');
      hellos.next(helloFrom('boot-1'));
      pinStates.next(report());
      await settle();
      expect(recorded(divergences)).toMatchObject([
        { isExplainedByReboot: false },
      ]);
      service.onModuleDestroy();
    });

    it('does not explain one when the stored boot id predates the column', async () => {
      const { service, pinStates, hellos, divergences } = await started(
        'unprompted',
        null,
      );
      hellos.next(helloFrom('boot-2'));
      pinStates.next(report());
      await settle();
      expect(recorded(divergences)).toMatchObject([
        { isExplainedByReboot: false },
      ]);
      service.onModuleDestroy();
    });

    it('trusts a hello that arrives while the stored boot ids load', async () => {
      const { service, pinStates, hellos, divergences } = armed('unprompted');
      const starting = service.onModuleInit();
      hellos.next(helloFrom('boot-2'));
      await starting;
      hellos.next(helloFrom('boot-3'));
      pinStates.next(report());
      await settle();
      expect(recorded(divergences)).toMatchObject([
        { isExplainedByReboot: true },
      ]);
      service.onModuleDestroy();
    });
  });
});
