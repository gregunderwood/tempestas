import {
  MQTT_ROOT,
  MQTT_SCHEMAS,
  schemaMajor,
  type AlarmPayload,
  type GpioLevel,
  type GpioLine,
  type GpioResultPayload,
  type GpioSetPayload,
  type GpioStatePayload,
  type GpioSyncPayload,
  type HelloPayload,
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

/**
 * Everything about the MQTT wire that can be decided without a socket.
 *
 * Topic parsing, payload validation and readback verification live here as pure
 * functions so they can be asserted directly. The driver is then thin enough to
 * be read in one sitting, which matters for the one component that turns a
 * network message into a relay command.
 *
 * The rule this file enforces above all others: a message that cannot be fully
 * understood is DROPPED, never partially applied. Half-parsing a sample yields a
 * temperature the rules engine will act on.
 */

/** The contract major this build speaks. An unknown major is refused, not parsed. */
export const SUPPORTED_MAJOR = 1;

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

/** `tempestas/v1/node/elantris/sensor/scd4x-0/sample` -> its parts, or null. */
export function parseNodeTopic(topic: string): ParsedTopic | null {
  const prefix = `${MQTT_ROOT}/node/`;
  if (!topic.startsWith(prefix)) {
    return null;
  }
  const [nodeId, ...rest] = topic.slice(prefix.length).split('/');
  if (!nodeId || rest.length === 0) {
    return null;
  }

  const path = rest.join('/');
  if (path === 'hello') return { nodeId, kind: 'hello' };
  if (path === 'status') return { nodeId, kind: 'status' };
  if (path === 'gpio/set') return { nodeId, kind: 'gpio-set' };
  if (path === 'gpio/sync') return { nodeId, kind: 'gpio-sync' };
  if (path === 'gpio/result') return { nodeId, kind: 'gpio-result' };
  if (path === 'control/heartbeat') return { nodeId, kind: 'heartbeat' };
  if (path === 'alarm') return { nodeId, kind: 'alarm' };

  if (rest[0] === 'sensor' && rest[2] === 'sample' && rest.length === 3) {
    return { nodeId, kind: 'sample', sensorId: rest[1] };
  }
  if (rest[0] === 'gpio' && rest[1] === 'state' && rest.length === 3) {
    const pin = Number(rest[2]);
    if (!Number.isInteger(pin)) return { nodeId, kind: 'unknown' };
    return { nodeId, kind: 'gpio-state', pin };
  }
  return { nodeId, kind: 'unknown' };
}

export type DecodeFailure = { ok: false; reason: string };
export type Decoded<T> = { ok: true; value: T } | DecodeFailure;

export function parseJson(
  payload: Buffer | string,
): Decoded<Record<string, unknown>> {
  const text = payload.toString('utf8');
  if (text.trim() === '') {
    // A zero-length payload is how a retained message is CLEARED, not an error.
    return { ok: false, reason: 'empty payload' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reason: 'payload is not a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'payload is not valid JSON' };
  }
}

/** An unknown major is refused loudly; a matching one may still fail validation. */
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
  const bad = checkSchema(raw, MQTT_SCHEMAS.hello);
  if (bad) return bad;

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
    // Without a bootId a reboot is undetectable and the reading dedupe loses
    // its scope, so this is not an optional field.
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
  const bad = checkSchema(raw, MQTT_SCHEMAS.status);
  if (bad) return bad;

  const state = (raw as unknown as StatusPayload).state;
  if (state !== 'online' && state !== 'offline') {
    // Not defaulting to either: "stale is not off", and guessing online would
    // be worse still.
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

/**
 * A sample is dropped unless temperature is present and valid.
 *
 * Every rule reads temperature; a sample without it is not a partial reading,
 * it is nothing. CO2 is different - `valid: false` is a legitimate, meaningful
 * state that maps to null and keeps the burner off by day.
 */
export function decodeSample(
  raw: Record<string, unknown>,
  nodeId: NodeId,
  sensorId: string,
  receivedAt: Date,
): Decoded<SensorSample> {
  const bad = checkSchema(raw, MQTT_SCHEMAS.sample);
  if (bad) return bad;

  const payload = raw as unknown as SamplePayload;
  const m = payload.measurements;
  if (!m || typeof m !== 'object') {
    return { ok: false, reason: 'sample without measurements' };
  }

  const temperature = numeric(m.tempC);
  if (temperature === null) {
    return { ok: false, reason: 'sample without a valid temperature' };
  }
  const humidity = numeric(m.humidityPct);
  if (humidity === null) {
    return { ok: false, reason: 'sample without a valid humidity' };
  }

  return {
    ok: true,
    value: {
      nodeId,
      sensorId,
      // Server-stamped: a node's own clock is diagnostic data, never the axis.
      receivedAt,
      temperature,
      humidity,
      co2: numeric(m.co2Ppm),
      nodeSeq: Number.isInteger(payload.seq) ? (payload.seq as number) : null,
    },
  };
}

function numeric(
  measurement: { value: number | null; valid: boolean } | undefined,
): number | null {
  if (!measurement || measurement.valid !== true) return null;
  return typeof measurement.value === 'number' &&
    Number.isFinite(measurement.value)
    ? measurement.value
    : null;
}

export function decodeResult(
  raw: Record<string, unknown>,
): Decoded<GpioResultPayload> {
  const bad = checkSchema(raw, MQTT_SCHEMAS.gpioResult);
  if (bad) return bad;

  const payload = raw as unknown as GpioResultPayload;
  if (typeof payload.id !== 'string' || !Array.isArray(payload.lines)) {
    return { ok: false, reason: 'result without an id and lines' };
  }
  return { ok: true, value: payload };
}

/**
 * Did the node actually do what it was told?
 *
 * A command resolves only on a matching readback. The old system logged a failed
 * GPIO write and updated the database anyway, so the UI showed a heater running
 * when it was not - the whole point of an ack is to make that unwriteable.
 */
export function verifyResult(
  result: GpioResultPayload,
  requested: readonly PinCommand[],
): DecodeFailure | null {
  if (!result.ok) {
    const failed = result.lines
      .filter((l) => !l.ok)
      .map((l) => `pin ${l.pin}: ${l.error ?? 'failed'}`);
    return { ok: false, reason: failed.join('; ') || 'node reported failure' };
  }
  for (const command of requested) {
    const line = result.lines.find((l) => l.pin === command.pin);
    if (!line) {
      return { ok: false, reason: `no result for pin ${command.pin}` };
    }
    if (!line.ok) {
      return {
        ok: false,
        reason: `pin ${command.pin}: ${line.error ?? 'failed'}`,
      };
    }
    // A readback the node could not take is NOT a success. `null` means unknown,
    // and unknown state on a burner relay is exactly what must not be believed.
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
): Decoded<{ pin: number; level: GpioLevel | null; known: boolean }> {
  const bad = checkSchema(raw, MQTT_SCHEMAS.gpioState);
  if (bad) return bad;

  const payload = raw as unknown as GpioStatePayload;
  // `known: false` is a first-class state, not an error: it is what a node
  // reports for a line it has not claimed or cannot read back. Stale is not off.
  if (payload.known !== true) {
    return { ok: true, value: { pin, level: null, known: false } };
  }
  if (payload.level !== 0 && payload.level !== 1) {
    return {
      ok: false,
      reason: `gpio/state claims known with level "${String(payload.level)}"`,
    };
  }
  return { ok: true, value: { pin, level: payload.level, known: true } };
}

export function decodeAlarm(
  raw: Record<string, unknown>,
): Decoded<AlarmPayload> {
  const bad = checkSchema(raw, MQTT_SCHEMAS.alarm);
  if (bad) return bad;

  const payload = raw as unknown as AlarmPayload;
  if (typeof payload.code !== 'string' || typeof payload.message !== 'string') {
    return { ok: false, reason: 'alarm without a code and message' };
  }
  return { ok: true, value: payload };
}

export interface EnvelopeSeed {
  nodeId: NodeId;
  now: Date;
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
    // Every command expires. A command delivered late - by a broker that queued
    // it, or a node that reconnected - must be refused rather than obeyed.
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
  return commands.map((c) => ({
    pin: c.pin,
    level: c.level,
    ...(c.label ? { label: c.label } : {}),
  }));
}

export function buildStatus(
  node: NodeId,
  state: 'online' | 'offline',
  now: Date,
): StatusPayload {
  return { schema: MQTT_SCHEMAS.status, node, ts: now.toISOString(), state };
}
