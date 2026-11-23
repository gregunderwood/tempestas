import type { GpioLevel } from '../devices/device.model';
import type { NodeCapabilities, NodeId, NodeKind } from '../nodes/node.model';

export const MQTT_CONTRACT_VERSION = 'v1' as const;

/** Semver for the contract: a major changes it, a minor only adds to it. Agents version as major.minor.patch. */
export const MQTT_CONTRACT_MAJOR = 1;
export const MQTT_CONTRACT_MINOR = 1;
/** The minor that added `update`: a node on an older one never subscribes to it. */
export const UPDATE_COMMAND_CONTRACT_MINOR = 1;
export const MQTT_ROOT = `tempestas/${MQTT_CONTRACT_VERSION}` as const;

export const mqttTopics = {
  nodeRoot: (n: NodeId) => `${MQTT_ROOT}/node/${n}`,
  hello: (n: NodeId) => `${MQTT_ROOT}/node/${n}/hello`,
  status: (n: NodeId) => `${MQTT_ROOT}/node/${n}/status`,
  sample: (n: NodeId, s: string) => `${MQTT_ROOT}/node/${n}/sensor/${s}/sample`,
  gpioSet: (n: NodeId) => `${MQTT_ROOT}/node/${n}/gpio/set`,
  gpioSync: (n: NodeId) => `${MQTT_ROOT}/node/${n}/gpio/sync`,
  gpioState: (n: NodeId, pin: number) =>
    `${MQTT_ROOT}/node/${n}/gpio/state/${pin}`,
  gpioResult: (n: NodeId) => `${MQTT_ROOT}/node/${n}/gpio/result`,
  heartbeat: (n: NodeId) => `${MQTT_ROOT}/node/${n}/control/heartbeat`,
  alarm: (n: NodeId) => `${MQTT_ROOT}/node/${n}/alarm`,
  update: (n: NodeId) => `${MQTT_ROOT}/node/${n}/update`,
  updateStatus: (n: NodeId) => `${MQTT_ROOT}/node/${n}/update/status`,
  allNodes: `${MQTT_ROOT}/node/+/#`,
  serverStatus: `${MQTT_ROOT}/server/status`,
} as const;

/** "name/major": both sides reject an unknown major loudly rather than parse hopefully. */
export const MQTT_SCHEMAS = {
  hello: 'hello/1',
  status: 'status/1',
  sample: 'sample/1',
  gpioSet: 'gpioSet/1',
  gpioSync: 'gpioSync/1',
  gpioState: 'gpioState/1',
  gpioResult: 'gpioResult/1',
  heartbeat: 'heartbeat/1',
  alarm: 'alarm/1',
  update: 'update/1',
  updateStatus: 'updateStatus/1',
} as const;

/** `"sample/2"` -> `2`. Null when the value is not a schema string at all. */
export function schemaMajor(schema: unknown): number | null {
  if (typeof schema !== 'string') {
    return null;
  }
  const [, majorText] = schema.split('/');
  const major = Number(majorText);
  return Number.isInteger(major) ? major : null;
}

export interface MqttEnvelope {
  schema: string;
  node: NodeId;
  ts: string;
  seq?: number;
}

export interface HelloPayload extends MqttEnvelope {
  kind: NodeKind;
  /** Which program, such as `agent-linux`; absent from agents older than contract 1.0. */
  agentName?: string;
  agentVersion: string;
  capabilities: NodeCapabilities;
  /** Changes on every restart, so the server can detect a bounce. */
  bootId: string;
}

export type AvailabilityState = 'online' | 'offline';

export interface StatusPayload extends MqttEnvelope {
  state: AvailabilityState;
}

export interface Measurement {
  value: number | null;
  valid: boolean;
  unit: string;
  /** Present when valid is false, e.g. 'ZERO_READING'. */
  reason?: string;
}

export interface SamplePayload extends MqttEnvelope {
  sensor: string;
  measurements: {
    co2Ppm: Measurement;
    tempC: Measurement;
    humidityPct: Measurement;
  };
  sensorStatus: {
    ok: boolean;
    consecutiveFailures: number;
    lastSuccessTs: string | null;
  };
}

export interface GpioLine {
  pin: number;
  level: GpioLevel;
  /** Advisory, for logs only. The node attaches no meaning to it. */
  label?: string;
}

export interface GpioSetPayload extends MqttEnvelope {
  id: string;
  issuedBy: string;
  /** Rejected as COMMAND_EXPIRED after this instant. */
  expiresAt: string;
  lines: GpioLine[];
}

/** Full desired state, re-asserted on connect and on a heartbeat tick. */
export interface GpioSyncPayload extends MqttEnvelope {
  controller: string;
  epoch: number;
  /** Log intent without actuating: shadow mode for cutover. */
  dryRun: boolean;
  intent: GpioLine[];
}

export interface GpioStatePayload extends MqttEnvelope {
  pin: number;
  level: GpioLevel | null;
  known: boolean;
}

export interface GpioResultLine {
  pin: number;
  requested: GpioLevel;
  readback: GpioLevel | null;
  ok: boolean;
  error?: string;
}

export interface GpioResultPayload extends MqttEnvelope {
  id: string;
  ok: boolean;
  lines: GpioResultLine[];
}

/** The programs a node can run; an update names its target with one. */
export enum AgentApp {
  Linux = 'agent-linux',
  MicroPython = 'agent-micropython',
}

/** Added in contract 1.1. Owned, expiring and never retained, exactly like `gpio/set`. */
export interface UpdateCommandPayload extends MqttEnvelope {
  id: string;
  issuedBy: string;
  /** Rejected as COMMAND_EXPIRED after this instant. */
  expiresAt: string;
  app: AgentApp;
  /** `<contract major>.<contract minor>.<patch>`; a node refuses one for another major. */
  version: string;
  manifestUrl: string;
  /** Lowercase hex of the manifest's bytes; the manifest carries each file's own sha256. */
  manifestSha256: string;
}

export enum UpdateState {
  Downloading = 'downloading',
  Verifying = 'verifying',
  Installing = 'installing',
  Restarting = 'restarting',
  Healthy = 'healthy',
  RolledBack = 'rolled-back',
  Failed = 'failed',
}

/** Added in contract 1.1: how one update command is going, keyed by the command's `id`. */
export interface UpdateStatusPayload extends MqttEnvelope {
  id: string;
  state: UpdateState;
  /** Why it failed or rolled back; optional on the states that are going well. */
  reason?: string;
}

export enum AlarmCode {
  ReadbackMismatch = 'READBACK_MISMATCH',
  GpioChipLost = 'GPIO_CHIP_LOST',
  GpioLineBusy = 'GPIO_LINE_BUSY',
  SensorTimeout = 'SENSOR_TIMEOUT',
  SensorSelftestFail = 'SENSOR_SELFTEST_FAIL',
  I2cNack = 'I2C_NACK',
  DeadmanTripped = 'DEADMAN_TRIPPED',
  DeadmanCleared = 'DEADMAN_CLEARED',
  CommandExpired = 'COMMAND_EXPIRED',
  RetainedCommandDropped = 'RETAINED_COMMAND_DROPPED',
  ControllerConflict = 'CONTROLLER_CONFLICT',
  NoProgress = 'NO_PROGRESS',
  MinDwellClamped = 'MIN_DWELL_CLAMPED',
  SafeStateEntered = 'SAFE_STATE_ENTERED',
}

export interface AlarmPayload extends MqttEnvelope {
  code: AlarmCode;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

// Commands are never retained: read docs/Safety.md before changing any flag here.
export const mqttQos = {
  hello: { qos: 1, retain: false },
  status: { qos: 1, retain: true },
  sample: { qos: 0, retain: false },
  gpioSet: { qos: 1, retain: false },
  gpioSync: { qos: 1, retain: false },
  gpioState: { qos: 1, retain: true },
  gpioResult: { qos: 1, retain: false },
  /** QoS 0: a missed heartbeat must LOOK missed, not be redelivered late. */
  heartbeat: { qos: 0, retain: false },
  /** Never retained: a retained alarm resurrects a cleared fault. */
  alarm: { qos: 1, retain: false },
  update: { qos: 1, retain: false },
  updateStatus: { qos: 1, retain: false },
  serverStatus: { qos: 1, retain: true },
} as const;
