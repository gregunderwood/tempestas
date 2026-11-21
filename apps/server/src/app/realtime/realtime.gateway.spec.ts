import {
  REALTIME_EVENTS,
  type Device,
  type Reading,
  type RulesCycle,
  type UnsentSystemStatus,
} from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import { RealtimeGateway } from './realtime.gateway';

const PUBLISHED_AT = new Date('2026-01-10T12:00:01.000Z');

function reading(
  nodeId: string,
  temperature = 20,
  sensorId = 'scd4x-0',
): Reading {
  return {
    id: `r-${nodeId}-${sensorId}`,
    nodeId,
    sensorId,
    temperature,
    humidity: 55,
    co2: 600,
    createdAt: '2026-01-10T12:00:00.000Z',
  };
}

const STATUS: UnsentSystemStatus = {
  at: '2026-01-10T12:00:00.000Z',
  sensorStale: true,
  staleRoles: [],
  nodesOnline: 1,
  nodesTotal: 2,
  nodesPending: 0,
  isLeading: true,
  lastEvaluationAt: '2026-01-10T12:00:00.000Z',
};

function createGateway(clock = new FixedClock(PUBLISHED_AT)): RealtimeGateway {
  return new RealtimeGateway(clock);
}

function attach(gateway: RealtimeGateway) {
  const emit = vi.fn();
  // `server` is assigned by @WebSocketServer() at runtime.
  (gateway as unknown as { server: { emit: typeof emit } }).server = { emit };
  return emit;
}

function fakeClient() {
  return { emit: vi.fn() } as unknown as Parameters<
    RealtimeGateway['handleConnection']
  >[0];
}

describe('RealtimeGateway', () => {
  it('emits each event under its contract name', () => {
    const gateway = createGateway();
    const emit = attach(gateway);

    gateway.publishReading(reading('elantris'));
    gateway.publishDeviceState({ id: 'dev-1' } as Device);
    gateway.publishSystemStatus(STATUS);

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      REALTIME_EVENTS.readingLatest,
      REALTIME_EVENTS.deviceState,
      REALTIME_EVENTS.systemStatus,
    ]);
  });

  // The stale-sensor banner must not wait for the next tick to appear.
  it('replays the last reading per node and the last status to a new client', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.publishReading(reading('elantris', 20));
    gateway.publishReading(reading('elantris', 21));
    gateway.publishReading(reading('north-end'));
    gateway.publishSystemStatus(STATUS);

    const client = fakeClient();
    gateway.handleConnection(client);

    const events = (client.emit as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(events).toHaveLength(3); // two nodes, newest each, plus the status
    expect(events[0][1]).toMatchObject({ nodeId: 'elantris', temperature: 21 });
    expect(events[2][0]).toBe(REALTIME_EVENTS.systemStatus);
  });

  // Keyed by node alone, a new dashboard showed one pumphouse probe until the other spoke.
  it('replays the last reading of EVERY sensor on a node', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.publishReading(reading('pumphouse', 7, 'air'));
    gateway.publishReading(reading('pumphouse', 1.5, 'pipes'));

    const client = fakeClient();
    gateway.handleConnection(client);

    const events = (client.emit as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(events.map((event) => (event[1] as Reading).sensorId)).toEqual([
      'air',
      'pipes',
    ]);
  });

  it('does not replay device state', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.publishDeviceState({ id: 'dev-1' } as Device);

    const client = fakeClient();
    gateway.handleConnection(client);
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('stamps a published status with the server clock as it is sent', () => {
    const gateway = createGateway();
    const emit = attach(gateway);

    gateway.publishSystemStatus(STATUS);

    expect(emit).toHaveBeenCalledWith(REALTIME_EVENTS.systemStatus, {
      ...STATUS,
      sentAt: PUBLISHED_AT.toISOString(),
    });
  });

  // A replay stamped with its publish time would make a stalled server look like a browser clock running ahead.
  it('stamps a replayed status with the time of the replay, not of the publish', () => {
    const clock = new FixedClock(PUBLISHED_AT);
    const gateway = createGateway(clock);
    attach(gateway);
    gateway.publishSystemStatus(STATUS);
    clock.advanceSeconds(300);

    const client = fakeClient();
    gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith(REALTIME_EVENTS.systemStatus, {
      ...STATUS,
      sentAt: '2026-01-10T12:05:01.000Z',
    });
  });

  // Every publisher is mid-way through something that matters more than the dashboard.
  it('never throws when there is no server attached yet', () => {
    const gateway = createGateway();
    expect(() => gateway.publishReading(reading('elantris'))).not.toThrow();
  });

  it('never throws when emitting fails', () => {
    const gateway = createGateway();
    (gateway as unknown as { server: { emit: () => never } }).server = {
      emit: () => {
        throw new Error('socket gone');
      },
    };
    expect(() => gateway.publishSystemStatus(STATUS)).not.toThrow();
  });

  it('tracks connected clients', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.handleConnection(fakeClient());
    gateway.handleConnection(fakeClient());
    expect(gateway.connectedClients()).toBe(2);
    gateway.handleDisconnect();
    expect(gateway.connectedClients()).toBe(1);
  });
});

describe('RealtimeGateway rules cycles', () => {
  const cycleAt = (at: string): RulesCycle => ({
    at,
    evaluations: [],
    failingZones: [],
  });

  function rulesCyclesReplayedTo(
    client: ReturnType<typeof fakeClient>,
  ): unknown[][] {
    return (client.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === REALTIME_EVENTS.rulesCycle,
    );
  }

  it('emits a cycle under rules:cycle', () => {
    const gateway = createGateway();
    const emit = attach(gateway);
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:00.000Z'));
    expect(emit).toHaveBeenCalledWith(
      REALTIME_EVENTS.rulesCycle,
      cycleAt('2026-01-10T12:00:00.000Z'),
    );
  });

  it('replays only the newest cycle to a client that connects', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:00.000Z'));
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:10.000Z'));

    const client = fakeClient();
    gateway.handleConnection(client);
    expect(rulesCyclesReplayedTo(client)).toEqual([
      [REALTIME_EVENTS.rulesCycle, cycleAt('2026-01-10T12:00:10.000Z')],
    ]);
  });

  it('replays nothing once the cycle has been forgotten', () => {
    const gateway = createGateway();
    attach(gateway);
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:00.000Z'));
    gateway.forgetRulesCycle();

    const client = fakeClient();
    gateway.handleConnection(client);
    expect(rulesCyclesReplayedTo(client)).toEqual([]);
  });
});
