import {
  MQTT_ROOT,
  MQTT_SCHEMAS,
  schemaMajor,
  type AlarmPayload,
  type GpioLevel,
  type GpioLine,
  type GpioResultLine,
  type GpioResultPayload,
  type GpioSetPayload,
  type GpioStatePayload,
  type GpioSyncPayload,
  type HelloPayload,
  type Measurement,
  type NodeId,
  type SamplePayload,
  type StatusPayload,
} from '@tempestas/domain';
import type {
  NodeAvailability,
  NodeHello,
  PinCommand,
  SensorSample,
} from './hardware.service';

// A message that cannot be fully understood is dropped, never partially applied.

/** The contract major this build speaks. An unknown major is refused, not parsed. */
export const SUPPORTED_MAJOR = 1;

export const EMPTY_PAYLOAD_REASON = 'empty payload';

export type NodeTopicKind =
  | 'hello'
  | 'status'
  | 'sample'
  | 'gpio-set'
  | 'gpio-sync'
  | 'gpio-state'
  | 'gpio-result'
  | 'heartbeat'
  | 'alarm'
  | 'unknown';

export interface ParsedTopic {
  nodeId: NodeId;
  kind: NodeTopicKind;
  sensorId?: string;
  pin?: number;
}

export type DecodeFailure = { ok: false; reason: string };
export type Decoded<T> = { ok: true; value: T } | DecodeFailure;

export interface DecodedGpioState {
  pin: number;
  level: GpioLevel | null;
  known: boolean;
  observedAt: Date;
}

export interface EnvelopeSeed {
  nodeId: NodeId;
  now: Date;
}

const NODE_TOPIC_PREFIX = `${MQTT_ROOT}/node/`;

const FIXED_SUBTOPIC_KINDS = new Map<string, NodeTopicKind>([
  ['hello', 'hello'],
  ['status', 'status'],
  ['gpio/set', 'gpio-set'],
  ['gpio/sync', 'gpio-sync'],
  ['gpio/result', 'gpio-result'],
  ['control/heartbeat', 'heartbeat'],
  ['alarm', 'alarm'],
]);

/** `tempestas/v1/node/elantris/sensor/scd4x-0/sample` -> its parts, or null. */
export function parseNodeTopic(topic: string): ParsedTopic | null {
  if (!topic.startsWith(NODE_TOPIC_PREFIX)) {
    return null;
  }
  const [nodeId, ...subtopic] = topic
    .slice(NODE_TOPIC_PREFIX.length)
    .split('/');
  if (!nodeId || subtopic.length === 0) {
    return null;
  }

  const fixedKind = FIXED_SUBTOPIC_KINDS.get(subtopic.join('/'));
  if (fixedKind) return { nodeId, kind: fixedKind };

  const [area, identifier, leaf] = subtopic;
  const hasThreeSegments = subtopic.length === 3;
  if (hasThreeSegments && area === 'sensor' && leaf === 'sample') {
    return { nodeId, kind: 'sample', sensorId: identifier };
  }
  if (hasThreeSegments && area === 'gpio' && identifier === 'state') {
    const pin = Number(leaf);
    if (!Number.isInteger(pin)) return { nodeId, kind: 'unknown' };
    return { nodeId, kind: 'gpio-state', pin };
  }
  return { nodeId, kind: 'unknown' };
}

// A zero-length payload is how a retained message is cleared.
export function isEmptyPayload(payload: Buffer | string): boolean {
  return payload.toString('utf8').trim() === '';
}

export function isGpioLevel(value: unknown): value is GpioLevel {
  return value === 0 || value === 1;
}

export function parseJson(
  payload: Buffer | string,
): Decoded<Record<string, unknown>> {
  if (isEmptyPayload(payload)) {
    return { ok: false, reason: EMPTY_PAYLOAD_REASON };
  }
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'));
    if (!isJsonObject(value)) {
      return { ok: false, reason: 'payload is not a JSON object' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'payload is not valid JSON' };
  }
}

export function checkSchema(
  raw: Record<string, unknown>,
  expected: string,
): DecodeFailure | null {
  const major = schemaMajor(raw['schema']);
  if (major === null) {
    return {
      ok: false,
      reason: `missing or malformed schema (expected ${expected})`,
    };
  }
  if (major !== SUPPORTED_MAJOR) {
    return {
      ok: false,
      reason: `unsupported schema major ${major} (this build speaks ${SUPPORTED_MAJOR})`,
    };
  }
  return null;
}

export function decodeHello(
  raw: Record<string, unknown>,
  nodeId: NodeId,
  receivedAt: Date,
): Decoded<NodeHello> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.hello);
  if (schemaFailure) return schemaFailure;

  const payload = raw as unknown as HelloPayload;
  if (!payload.capabilities || typeof payload.capabilities !== 'object') {
    return { ok: false, reason: 'hello without capabilities' };
  }
  if (payload.capabilities.contractVersion !== SUPPORTED_MAJOR) {
    return {
      ok: false,
      reason: `capabilities.contractVersion ${payload.capabilities.contractVersion} is not ${SUPPORTED_MAJOR}`,
    };
  }
  if (typeof payload.bootId !== 'string' || payload.bootId === '') {
    // Required: without it a reboot is undetectable and the reading dedupe loses its scope.
    return { ok: false, reason: 'hello without a bootId' };
  }
  if (!payload.kind) {
    return { ok: false, reason: 'hello without a kind' };
  }

  return {
    ok: true,
    value: {
      nodeId,
      kind: payload.kind,
      agentVersion:
        typeof payload.agentVersion === 'string'
          ? payload.agentVersion
          : 'unknown',
      capabilities: payload.capabilities,
      bootId: payload.bootId,
      receivedAt,
    },
  };
}

export function decodeStatus(
  raw: Record<string, unknown>,
  nodeId: NodeId,
  receivedAt: Date,
): Decoded<NodeAvailability> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.status);
  if (schemaFailure) return schemaFailure;

  const state = (raw as unknown as StatusPayload).state;
  if (state !== 'online' && state !== 'offline') {
    // Never defaulted: stale is not off, and guessing online is worse still.
    return {
      ok: false,
      reason: `status with unknown state "${String(state)}"`,
    };
  }
  return {
    ok: true,
    value: { nodeId, online: state === 'online', at: receivedAt },
  };
}

// Temperature is required; CO2 and humidity may be invalid, which maps to null.
export function decodeSample(
  raw: Record<string, unknown>,
  nodeId: NodeId,
  sensorId: string,
  receivedAt: Date,
): Decoded<SensorSample> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.sample);
  if (schemaFailure) return schemaFailure;

  const payload = raw as unknown as SamplePayload;
  const measurements = payload.measurements;
  if (!measurements || typeof measurements !== 'object') {
    return { ok: false, reason: 'sample without measurements' };
  }

  const temperature = readValidMeasurement(measurements.tempC);
  if (temperature === null) {
    return { ok: false, reason: 'sample without a valid temperature' };
  }
  return {
    ok: true,
    value: {
      nodeId,
      sensorId,
      // Server-stamped: a node's own clock is diagnostic data, never the axis.
      receivedAt,
      temperature,
      humidity: readValidMeasurement(measurements.humidityPct),
      co2: readValidMeasurement(measurements.co2Ppm),
      nodeSeq: Number.isInteger(payload.seq) ? (payload.seq as number) : null,
    },
  };
}

export function decodeResult(
  raw: Record<string, unknown>,
): Decoded<GpioResultPayload> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.gpioResult);
  if (schemaFailure) return schemaFailure;

  const payload = raw as unknown as GpioResultPayload;
  if (typeof payload.id !== 'string' || !Array.isArray(payload.lines)) {
    return { ok: false, reason: 'result without an id and lines' };
  }
  return { ok: true, value: payload };
}

export function verifyResult(
  result: GpioResultPayload,
  requested: readonly PinCommand[],
): DecodeFailure | null {
  if (!result.ok) {
    const failed = result.lines
      .filter((line) => !line.ok)
      .map(describeLineFailure);
    return { ok: false, reason: failed.join('; ') || 'node reported failure' };
  }
  for (const command of requested) {
    const line = result.lines.find(
      (resultLine) => resultLine.pin === command.pin,
    );
    if (!line) {
      return { ok: false, reason: `no result for pin ${command.pin}` };
    }
    if (!line.ok) {
      return { ok: false, reason: describeLineFailure(line) };
    }
    // A `null` readback is unknown, and unknown on a burner relay is never success.
    if (line.readback !== command.level) {
      return {
        ok: false,
        reason: `pin ${command.pin} read back ${String(line.readback)}, expected ${command.level}`,
      };
    }
  }
  return null;
}

export function decodeGpioState(
  raw: Record<string, unknown>,
  pin: number,
): Decoded<DecodedGpioState> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.gpioState);
  if (schemaFailure) return schemaFailure;

  const payload = raw as unknown as GpioStatePayload;
  // Refused, not defaulted to now: our clock would restart a burner's cooldown.
  const observedAt = new Date(payload.ts);
  if (Number.isNaN(observedAt.getTime())) {
    return {
      ok: false,
      reason: `gpio/state has an unparseable ts "${String(payload.ts)}"`,
    };
  }
  if (payload.known !== true) {
    return { ok: true, value: { pin, level: null, known: false, observedAt } };
  }
  if (!isGpioLevel(payload.level)) {
    return {
      ok: false,
      reason: `gpio/state claims known with level "${String(payload.level)}"`,
    };
  }
  return {
    ok: true,
    value: { pin, level: payload.level, known: true, observedAt },
  };
}

export function decodeAlarm(
  raw: Record<string, unknown>,
): Decoded<AlarmPayload> {
  const schemaFailure = checkSchema(raw, MQTT_SCHEMAS.alarm);
  if (schemaFailure) return schemaFailure;

  const payload = raw as unknown as AlarmPayload;
  if (typeof payload.code !== 'string' || typeof payload.message !== 'string') {
    return { ok: false, reason: 'alarm without a code and message' };
  }
  return { ok: true, value: payload };
}

export function buildGpioSet(
  seed: EnvelopeSeed,
  id: string,
  issuedBy: string,
  lines: readonly GpioLine[],
  ttlMs: number,
): GpioSetPayload {
  return {
    schema: MQTT_SCHEMAS.gpioSet,
    node: seed.nodeId,
    ts: seed.now.toISOString(),
    id,
    issuedBy,
    // Every command expires, so one delivered late is refused rather than obeyed.
    expiresAt: new Date(seed.now.getTime() + ttlMs).toISOString(),
    lines: [...lines],
  };
}

export function buildGpioSync(
  seed: EnvelopeSeed,
  controller: string,
  epoch: number,
  intent: readonly GpioLine[],
  dryRun: boolean,
): GpioSyncPayload {
  return {
    schema: MQTT_SCHEMAS.gpioSync,
    node: seed.nodeId,
    ts: seed.now.toISOString(),
    controller,
    epoch,
    dryRun,
    intent: [...intent],
  };
}

export function toGpioLines(commands: readonly PinCommand[]): GpioLine[] {
  return commands.map((command) => ({
    pin: command.pin,
    level: command.level,
    ...(command.label ? { label: command.label } : {}),
  }));
}

export function buildStatus(
  node: NodeId,
  state: 'online' | 'offline',
  now: Date,
): StatusPayload {
  return { schema: MQTT_SCHEMAS.status, node, ts: now.toISOString(), state };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readValidMeasurement(
  measurement: Pick<Measurement, 'value' | 'valid'> | undefined,
): number | null {
  if (!measurement || measurement.valid !== true) return null;
  return typeof measurement.value === 'number' &&
    Number.isFinite(measurement.value)
    ? measurement.value
    : null;
}

function describeLineFailure(line: GpioResultLine): string {
  return `pin ${line.pin}: ${line.error ?? 'failed'}`;
}
