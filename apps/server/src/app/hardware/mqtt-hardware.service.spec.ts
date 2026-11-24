import { EventEmitter } from 'node:events';
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
import { MqttHardwareService } from './mqtt-hardware.service';
import type { UpdateOrder } from './hardware.service';

vi.mock('mqtt', () => ({ connect: vi.fn() }));

const NOW = new Date('2026-11-21T12:00:00Z');

interface PendingSubscription {
  acknowledge: () => void;
  refuse: (error: Error) => void;
}

class FakeBrokerClient extends EventEmitter {
  readonly publishedTopics: string[] = [];
  connected = false;
  private readonly pendingSubscriptions: PendingSubscription[] = [];

  readonly subscribeAsync = vi.fn(
    () =>
      new Promise<void>((acknowledge, refuse) => {
        this.pendingSubscriptions.push({ acknowledge, refuse });
      }),
  );

  readonly publishAsync = vi.fn(async (topic: string) => {
    this.publishedTopics.push(topic);
  });

  readonly endAsync = vi.fn(async () => undefined);

  connectToBroker(): void {
    this.connected = true;
    this.emit('connect');
  }

  loseConnection(): void {
    this.connected = false;
    this.takeOldestSubscription().refuse(new Error('Connection closed'));
    this.emit('close');
  }

  acknowledgeSubscribe(): void {
    this.takeOldestSubscription().acknowledge();
  }

  refuseSubscribe(error: Error): void {
    this.takeOldestSubscription().refuse(error);
  }

  private takeOldestSubscription(): PendingSubscription {
    const oldest = this.pendingSubscriptions.shift();
    if (!oldest) throw new Error('No subscribe is waiting for its SUBACK');
    return oldest;
  }

  deliver(topic: string, payload: unknown): void {
    this.emit('message', topic, Buffer.from(JSON.stringify(payload)), {
      retain: false,
    });
  }

  hasAnnouncedServerStatus(): boolean {
    return this.publishedTopics.includes(mqttTopics.serverStatus);
  }
}

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
