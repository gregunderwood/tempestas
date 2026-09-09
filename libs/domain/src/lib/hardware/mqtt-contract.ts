import type { GpioLevel } from '../devices/device.model';
import type { NodeCapabilities, NodeId, NodeKind } from '../nodes/node.model';

/**
 * The MQTT contract between the server and every node.
 *
 * ============================ SAFETY RULES ============================
 *
 * 1. COMMANDS ARE NEVER RETAINED.
 *    A retained `gpio/set` replays on every reconnect of a node that may be
 *    running a gas burner. State and status are retained; commands are not.
 *
 *    ⚠ THE RETAIN FLAG IS NOT A SUFFICIENT DEFENCE, and it is worth knowing
 *    exactly why. MQTT sets the retain flag on a delivered PUBLISH only when
 *    the message is delivered BECAUSE OF a new subscription. A retained
 *    command published while the node and server are already subscribed
 *    arrives with retain=0 and is indistinguishable from a legitimate command
 *    - and then lurks, retained, to replay on every future reconnect. This was
 *    verified against a real broker, not reasoned about.
 *
 *    So the guards are layered, and the ownership one does the real work:
 *      a. THE SERVER IS THE ONLY LEGITIMATE PUBLISHER of `gpio/set` and
 *         `gpio/sync`. Any command whose `issuedBy` (or `controller`) is not
 *         the current controller is a CONTROLLER_CONFLICT, whatever its retain
 *         flag says. The server alarms and CLEARS the retained slot; a node
 *         must refuse it;
 *      b. the node also drops any inbound command carrying the retain flag,
 *         and publishes RETAINED_COMMAND_DROPPED - this catches the
 *         replay-on-reconnect case;
 *      c. every command carries `expiresAt` and is rejected when late;
 *      d. both ends connect with cleanStart - a persistent session is
 *         precisely a queue of commands waiting to replay;
 *      e. broker ACLs restrict publish rights per client, which is the only
 *         layer that stops a foreign command from ever being delivered.
 *
 *    A zero-length payload on a command topic is how a retained command is
 *    CLEARED. Every agent must ignore an empty command payload rather than
 *    parsing it, and must never react to one.
 *
 * 2. STALE IS NOT OFF.
 *    When a node's LWT fires, its pins become UNKNOWN, not 0. Only a fresh
 *    retained gpio/state or a successful sync restores known state.
 *
 * 3. THE SERVER HAS AN LWT TOO.
 *    So that every node fails safe when the brain dies, not just one.
 *
 * 4. LEVELS, NOT ON/OFF.
 *    The wire carries electrical levels only. The server owns the
 *    active-high/active-low translation. The single exception is a node's
 *    configured failsafe level, which must live on the node because when the
 *    server is gone there is nobody to ask what "safe" means.
 *
 * ======================================================================
 */

export const MQTT_CONTRACT_VERSION = 'v1' as const;
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
  /** Server subscribes here to catch every node at once. */
  allNodes: `${MQTT_ROOT}/node/+/#`,
  serverStatus: `${MQTT_ROOT}/server/status`,
} as const;

/**
 * The `schema` value for each payload, as "name/major".
 *
 * Both sides reject an unknown MAJOR loudly rather than parsing hopefully: a
 * silently-extended payload is how a Python agent and a TypeScript server come
 * to disagree about what a field means at 2 a.m. Adding a field is a minor
 * change and needs no bump; changing or removing one does.
 */
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
} as const;

/** `"sample/2"` -> `2`. Null when the value is not a schema string at all. */
export function schemaMajor(schema: unknown): number | null {
  if (typeof schema !== 'string') return null;
  const major = Number(schema.split('/')[1]);
  return Number.isInteger(major) ? major : null;
}

/** Every payload carries these. */
export interface MqttEnvelope {
  /** "name/major" - consumers reject unknown majors loudly. */
  schema: string;
  node: NodeId;
  /** ISO-8601 with offset. */
  ts: string;
  seq?: number;
}

export interface HelloPayload extends MqttEnvelope {
  kind: NodeKind;
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
  /** Log intent without actuating - the shadow-mode mechanism for cutover. */
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

/** QoS and retain, per topic. Encoded so it cannot drift into folklore. */
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
  /** Never retained - a retained alarm resurrects a cleared fault. */
  alarm: { qos: 1, retain: false },
  serverStatus: { qos: 1, retain: true },
} as const;
