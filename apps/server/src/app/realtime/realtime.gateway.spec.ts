import {
  REALTIME_EVENTS,
  type Device,
  type Reading,
  type RulesCycle,
  type SystemStatus,
} from '@tempestas/domain';
import { RealtimeGateway } from './realtime.gateway';

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

const STATUS: SystemStatus = {
  at: '2026-01-10T12:00:00.000Z',
  sensorStale: true,
  staleRoles: [],
  nodesOnline: 1,
  nodesTotal: 2,
  nodesPending: 0,
  isLeading: true,
  lastEvaluationAt: '2026-01-10T12:00:00.000Z',
};

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
    const gateway = new RealtimeGateway();
    const emit = attach(gateway);

    gateway.publishReading(reading('elantris'));
    gateway.publishDeviceState({ id: 'dev-1' } as Device);
    gateway.publishSystemStatus(STATUS);

    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      REALTIME_EVENTS.readingLatest,
      REALTIME_EVENTS.deviceState,
      REALTIME_EVENTS.systemStatus,
    ]);
  });

  // A browser that connects mid-cycle should render immediately rather than
  // showing an empty dashboard for ten seconds - and the stale-sensor banner in
  // particular must not wait for the next tick to appear.
  it('replays the last reading per node and the last status to a new client', () => {
    const gateway = new RealtimeGateway();
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

  // Keyed by node alone, a newly opened dashboard showed one pumphouse probe
  // until the other next spoke.
  it('replays the last reading of EVERY sensor on a node', () => {
    const gateway = new RealtimeGateway();
    attach(gateway);
    gateway.publishReading(reading('pumphouse', 7, 'air'));
    gateway.publishReading(reading('pumphouse', 1.5, 'pipes'));

    const client = fakeClient();
    gateway.handleConnection(client);

    const events = (client.emit as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(events.map((e) => (e[1] as Reading).sensorId)).toEqual([
      'air',
      'pipes',
    ]);
  });

  // Device state is authoritative from GET /api/devices. A cached copy replayed
  // on connect could contradict it, so it is deliberately not cached.
  it('does not replay device state', () => {
    const gateway = new RealtimeGateway();
    attach(gateway);
    gateway.publishDeviceState({ id: 'dev-1' } as Device);

    const client = fakeClient();
    gateway.handleConnection(client);
    expect(client.emit).not.toHaveBeenCalled();
  });

  // Every publisher is mid-way through something that matters more than the
  // dashboard - an ingest, a relay write, a rules evaluation - so a socket
  // failure must never propagate into the caller.
  it('never throws when there is no server attached yet', () => {
    const gateway = new RealtimeGateway();
    expect(() => gateway.publishReading(reading('elantris'))).not.toThrow();
  });

  it('never throws when emitting fails', () => {
    const gateway = new RealtimeGateway();
    (gateway as unknown as { server: { emit: () => never } }).server = {
      emit: () => {
        throw new Error('socket gone');
      },
    };
    expect(() => gateway.publishSystemStatus(STATUS)).not.toThrow();
  });

  it('tracks connected clients', () => {
    const gateway = new RealtimeGateway();
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
    const gateway = new RealtimeGateway();
    const emit = attach(gateway);
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:00.000Z'));
    expect(emit).toHaveBeenCalledWith(
      REALTIME_EVENTS.rulesCycle,
      cycleAt('2026-01-10T12:00:00.000Z'),
    );
  });

  it('replays only the newest cycle to a client that connects', () => {
    const gateway = new RealtimeGateway();
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
    const gateway = new RealtimeGateway();
    attach(gateway);
    gateway.publishRulesCycle(cycleAt('2026-01-10T12:00:00.000Z'));
    gateway.forgetRulesCycle();

    const client = fakeClient();
    gateway.handleConnection(client);
    expect(rulesCyclesReplayedTo(client)).toEqual([]);
  });
});
