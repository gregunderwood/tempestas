import { EventEmitter } from 'node:events';
import { AgentApp, MQTT_SCHEMAS, mqttTopics } from '@tempestas/domain';
import { vi } from 'vitest';

interface PendingSubscription {
  acknowledge: () => void;
  refuse: (error: Error) => void;
}

export class FakeBrokerClient extends EventEmitter {
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

  readonly publish = vi.fn();

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

export function buildHelloPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: MQTT_SCHEMAS.hello,
    node: 'patji',
    ts: new Date().toISOString(),
    kind: 'rpi',
    agentName: AgentApp.Linux,
    agentVersion: '1.2.0',
    bootId: 'boot-1',
    capabilities: { contractVersion: 1, contractMinor: 2 },
    ...overrides,
  };
}
