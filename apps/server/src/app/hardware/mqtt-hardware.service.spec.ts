import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { connect } from 'mqtt';
import { mqttTopics } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import { MqttHardwareService } from './mqtt-hardware.service';

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
