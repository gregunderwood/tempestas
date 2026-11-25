import { ConfigService } from '@nestjs/config';
import { connect } from 'mqtt';
import {
  AgentApp,
  ApiErrorCode,
  MQTT_SCHEMAS,
  mqttQos,
  mqttTopics,
  UpdateState,
} from '@tempestas/domain';
import { firstValueFrom } from 'rxjs';
import { FixedClock } from '../common/clock';
import {
  HEARTBEAT_INTERVAL_MS,
  MqttHardwareService,
} from './mqtt-hardware.service';
import type { UpdateOrder } from './hardware.service';
import {
  buildHelloPayload,
  FakeBrokerClient,
} from './fake-broker-client.fixtures';

vi.mock('mqtt', () => ({ connect: vi.fn() }));

const NOW = new Date('2026-11-21T12:00:00Z');

async function settlePendingWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MqttHardwareService on a broker connect', () => {
  let brokerClient: FakeBrokerClient;
  let service: MqttHardwareService;

  beforeEach(() => {
    brokerClient = new FakeBrokerClient();
    vi.mocked(connect).mockReturnValue(
      brokerClient as unknown as ReturnType<typeof connect>,
    );
    service = new MqttHardwareService(
      new ConfigService({ CONTROLLER_ROLE: 'leader' }),
      new FixedClock(NOW),
    );
    service.onApplicationBootstrap();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('subscribes to every node before announcing online', async () => {
    brokerClient.connectToBroker();
    await settlePendingWork();

    expect(brokerClient.subscribeAsync).toHaveBeenCalledWith(
      mqttTopics.allNodes,
      expect.anything(),
    );
    expect(brokerClient.hasAnnouncedServerStatus()).toBe(false);
  });

  it('announces online once the subscription is acknowledged, so the answering hellos are caught', async () => {
    brokerClient.connectToBroker();
    await settlePendingWork();

    brokerClient.acknowledgeSubscribe();
    await settlePendingWork();

    expect(brokerClient.hasAnnouncedServerStatus()).toBe(true);
  });

  it('still announces online when the subscribe is refused, because the server is connected and heartbeating', async () => {
    brokerClient.connectToBroker();
    await settlePendingWork();

    brokerClient.refuseSubscribe(new Error('Subscribe error: Not authorized'));
    await settlePendingWork();

    expect(brokerClient.hasAnnouncedServerStatus()).toBe(true);
  });

  it('drops the announcement when the connection is lost before the SUBACK, so it cannot replay ahead of the next subscribe', async () => {
    brokerClient.connectToBroker();
    await settlePendingWork();

    brokerClient.loseConnection();
    await settlePendingWork();

    expect(brokerClient.hasAnnouncedServerStatus()).toBe(false);
  });

  it('leaves the announcement to the newest connect when a reconnect overtakes a slow subscribe', async () => {
    brokerClient.connectToBroker();
    await settlePendingWork();
    brokerClient.connectToBroker();
    await settlePendingWork();

    brokerClient.acknowledgeSubscribe();
    await settlePendingWork();
    expect(brokerClient.hasAnnouncedServerStatus()).toBe(false);

    brokerClient.acknowledgeSubscribe();
    await settlePendingWork();
    expect(brokerClient.publishedTopics).toEqual([mqttTopics.serverStatus]);
  });

  it('turns off the library resubscribe, which would acknowledge a reconnect subscribe before the SUBACK', () => {
    expect(connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resubscribe: false }),
    );
  });
});

describe('MqttHardwareService server status by role', () => {
  let brokerClient: FakeBrokerClient;
  let startedService: MqttHardwareService | undefined;

  function startService(role: string): MqttHardwareService {
    const service = new MqttHardwareService(
      new ConfigService({ CONTROLLER_ROLE: role }),
      new FixedClock(NOW),
    );
    service.onApplicationBootstrap();
    startedService = service;
    return service;
  }

  async function connectAndAcknowledgeSubscribe(): Promise<void> {
    brokerClient.connectToBroker();
    await settlePendingWork();
    brokerClient.acknowledgeSubscribe();
    await settlePendingWork();
  }

  beforeEach(() => {
    brokerClient = new FakeBrokerClient();
    vi.mocked(connect).mockReturnValue(
      brokerClient as unknown as ReturnType<typeof connect>,
    );
  });

  afterEach(async () => {
    await startedService?.onModuleDestroy();
    startedService = undefined;
  });

  it('a leader announces online on connect and offline on a clean shutdown', async () => {
    const service = startService('leader');
    await connectAndAcknowledgeSubscribe();

    await service.onModuleDestroy();

    expect(brokerClient.publishedServerStates).toEqual(['online', 'offline']);
  });

  it("a follower announces nothing on connect, so it cannot cover a crashed leader's will", async () => {
    startService('follower');
    await connectAndAcknowledgeSubscribe();

    expect(brokerClient.hasAnnouncedServerStatus()).toBe(false);
  });

  it('a follower announces nothing on a clean shutdown, so its restart does not tell nodes the server is gone', async () => {
    const service = startService('follower');
    await connectAndAcknowledgeSubscribe();

    await service.onModuleDestroy();

    expect(brokerClient.hasAnnouncedServerStatus()).toBe(false);
    expect(brokerClient.endAsync).toHaveBeenCalled();
  });

  it("a follower registers no will, so a crash leaves the leader's status standing", () => {
    startService('follower');

    expect(connect).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.not.objectContaining({ will: expect.anything() }),
    );
  });
});

const ORDER: UpdateOrder = {
  id: '6f1c9e1e-8f7e-4a43-9c55-0d6f1d9b2b11',
  app: AgentApp.Linux,
  version: '1.1.1',
  manifestUrl:
    'http://elantris:7000/api/agent-releases/agent-linux/1.1.1/manifest.json',
  manifestSha256: 'b'.repeat(64),
};

describe('MqttHardwareService updates', () => {
  let brokerClient: FakeBrokerClient;

  function startService(role: string): MqttHardwareService {
    const service = new MqttHardwareService(
      new ConfigService({ CONTROLLER_ROLE: role }),
      new FixedClock(NOW),
    );
    service.onApplicationBootstrap();
    return service;
  }

  beforeEach(() => {
    brokerClient = new FakeBrokerClient();
    vi.mocked(connect).mockReturnValue(
      brokerClient as unknown as ReturnType<typeof connect>,
    );
  });

  it('publishes the update on the node topic, never retained', async () => {
    const service = startService('leader');
    brokerClient.connected = true;

    await service.sendUpdate('patji', ORDER);

    const [topic, body, options] = brokerClient.publishAsync.mock
      .calls[0] as unknown as [string, string, unknown];
    expect(topic).toBe(mqttTopics.update('patji'));
    expect(options).toEqual(mqttQos.update);
    expect(JSON.parse(body)).toMatchObject({
      schema: MQTT_SCHEMAS.update,
      id: ORDER.id,
      version: '1.1.1',
      manifestUrl: ORDER.manifestUrl,
    });
    await service.onModuleDestroy();
  });

  it('refuses to send an update from a follower', async () => {
    const service = startService('follower');

    await expect(service.sendUpdate('patji', ORDER)).rejects.toMatchObject({
      code: ApiErrorCode.ControllerIsFollower,
    });
    expect(brokerClient.publishAsync).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('refuses while the broker is disconnected, as mqtt.js would hold the command and send it late', async () => {
    const service = startService('leader');

    await expect(service.sendUpdate('patji', ORDER)).rejects.toMatchObject({
      code: ApiErrorCode.HardwareUnreachable,
    });
    expect(brokerClient.publishAsync).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('gives up on a publish the broker never acknowledges', async () => {
    vi.useFakeTimers();
    const service = startService('leader');
    brokerClient.connected = true;
    brokerClient.publishAsync.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    const sending = service.sendUpdate('patji', ORDER);
    const refused = expect(sending).rejects.toMatchObject({
      code: ApiErrorCode.HardwareUnreachable,
      message: expect.stringContaining('did not acknowledge'),
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await refused;
    vi.useRealTimers();
    await service.onModuleDestroy();
  });

  it('passes on what a node reports about its update', async () => {
    const service = startService('leader');
    const reported = firstValueFrom(service.updateStatuses$);

    brokerClient.deliver(mqttTopics.updateStatus('patji'), {
      schema: MQTT_SCHEMAS.updateStatus,
      node: 'patji',
      ts: NOW.toISOString(),
      id: ORDER.id,
      state: UpdateState.Installing,
    });

    await expect(reported).resolves.toEqual({
      nodeId: 'patji',
      id: ORDER.id,
      state: UpdateState.Installing,
      reason: null,
    });
    await service.onModuleDestroy();
  });
});

describe('MqttHardwareService heartbeats', () => {
  let brokerClient: FakeBrokerClient;
  let service: MqttHardwareService;

  function storeEachHello(): void {
    service.hello$.subscribe((accepted) =>
      service.recordAcceptedHello(accepted),
    );
  }

  async function sendHeartbeats(): Promise<Record<string, unknown>[]> {
    brokerClient.publish.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    return brokerClient.publish.mock.calls
      .filter(([topic]) => topic === mqttTopics.heartbeat('patji'))
      .map(([, body]) => JSON.parse(body as string));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    brokerClient = new FakeBrokerClient();
    vi.mocked(connect).mockReturnValue(
      brokerClient as unknown as ReturnType<typeof connect>,
    );
    service = new MqttHardwareService(
      new ConfigService({ CONTROLLER_ROLE: 'leader' }),
      new FixedClock(NOW),
    );
    service.onApplicationBootstrap();
    brokerClient.connectToBroker();
    await vi.advanceTimersByTimeAsync(0);
    brokerClient.acknowledgeSubscribe();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('names the agent version once the registry has stored its hello', async () => {
    storeEachHello();
    brokerClient.deliver(mqttTopics.hello('patji'), buildHelloPayload());

    const [heartbeat] = await sendHeartbeats();

    expect(heartbeat).toMatchObject({
      schema: MQTT_SCHEMAS.heartbeat,
      node: 'patji',
      agentVersion: '1.2.0',
    });
  });

  it('names no version for a hello the registry has not stored', async () => {
    brokerClient.deliver(mqttTopics.hello('patji'), buildHelloPayload());

    const [heartbeat] = await sendHeartbeats();

    expect(heartbeat.agentVersion).toBeNull();
  });

  it('moves on to the new release once its hello is stored', async () => {
    storeEachHello();
    brokerClient.deliver(
      mqttTopics.hello('patji'),
      buildHelloPayload({ agentVersion: '1.1.0' }),
    );
    const [beforeUpdate] = await sendHeartbeats();
    brokerClient.deliver(
      mqttTopics.hello('patji'),
      buildHelloPayload({ agentVersion: '1.2.0', bootId: 'boot-2' }),
    );

    const [afterUpdate] = await sendHeartbeats();

    expect(beforeUpdate.agentVersion).toBe('1.1.0');
    expect(afterUpdate.agentVersion).toBe('1.2.0');
  });

  it('keeps naming the last stored version when a later hello is refused', async () => {
    storeEachHello();
    brokerClient.deliver(mqttTopics.hello('patji'), buildHelloPayload());
    brokerClient.deliver(
      mqttTopics.hello('patji'),
      buildHelloPayload({ agentVersion: '1.2.1', bootId: '' }),
    );

    const [heartbeat] = await sendHeartbeats();

    expect(heartbeat.agentVersion).toBe('1.2.0');
  });
});
