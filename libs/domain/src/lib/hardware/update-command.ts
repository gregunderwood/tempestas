import {
  AgentApp,
  AlarmCode,
  MQTT_CONTRACT_MAJOR,
  schemaMajor,
  UpdateState,
  type UpdateCommandPayload,
  type UpdateStatusPayload,
} from './mqtt-contract';

/** What a node knows when an `update` arrives. Time enters here, never from a clock. */
export interface UpdateCommandContext {
  isRetained: boolean;
  /** Null until the first heartbeat names the controller. */
  boundController: string | null;
  runningApp: AgentApp;
  now: Date;
}

/** How a refusal is answered: logged only, alarmed, or reported to the server as `failed`. */
export type UpdateCommandVerdict =
  | { isAccepted: true; command: UpdateCommandPayload }
  | { isAccepted: false; answer: 'log'; reason: string }
  | { isAccepted: false; answer: 'alarm'; reason: string; alarm: AlarmCode }
  | {
      isAccepted: false;
      answer: 'failed-status';
      reason: string;
      commandId: string;
    };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const AGENT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.+-]+)?$/;
// Stricter than `new Date`, so an agent's ISO parser and this judge refuse the same strings.
const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MANIFEST_URL_SCHEMES = new Set(['http:', 'https:']);
const AGENT_APPS = new Set<unknown>(Object.values(AgentApp));
const UPDATE_STATES = new Set<unknown>(Object.values(UpdateState));

/** The node's half of the update command, in the same order as `gpio/set`: retain, ownership, expiry. */
export function judgeUpdateCommand(
  payload: string,
  context: UpdateCommandContext,
): UpdateCommandVerdict {
  if (payload.trim() === '') {
    // Reacting to a clear, even by alarming, risks a loop against whoever cleared it.
    return logOnly('empty payload (a retained clear)');
  }
  if (context.isRetained) {
    return alarm(
      'update carried the retain flag',
      AlarmCode.RetainedCommandDropped,
    );
  }

  const body = parseJsonObject(payload);
  if (body === null) {
    return logOnly('payload is not a JSON object');
  }
  if (schemaMajor(body['schema']) !== MQTT_CONTRACT_MAJOR) {
    return logOnly(`unsupported schema ${String(body['schema'])}`);
  }

  const ownershipRefusal = judgeOwnership(
    body['issuedBy'],
    context.boundController,
  );
  if (ownershipRefusal) return ownershipRefusal;

  const expiryRefusal = judgeExpiry(body['expiresAt'], context.now);
  if (expiryRefusal) return expiryRefusal;

  const commandId = body['id'];
  if (!isNonEmptyString(commandId)) {
    return logOnly('update has no id');
  }

  const targetRefusal = describeTargetProblem(body, context.runningApp);
  if (targetRefusal) {
    return {
      isAccepted: false,
      answer: 'failed-status',
      reason: targetRefusal,
      commandId,
    };
  }
  return { isAccepted: true, command: body as unknown as UpdateCommandPayload };
}

/** True when the server can trust an `update/status` enough to show it. */
export function isUpdateStatusPayload(
  value: unknown,
): value is UpdateStatusPayload {
  if (!isJsonObject(value)) return false;
  if (schemaMajor(value['schema']) !== MQTT_CONTRACT_MAJOR) return false;
  if (!isNonEmptyString(value['id'])) return false;
  if (!UPDATE_STATES.has(value['state'])) return false;
  return value['reason'] === undefined || typeof value['reason'] === 'string';
}

export function readVersionMajor(version: string): number | null {
  const match = AGENT_VERSION.exec(version);
  return match ? Number(match[1]) : null;
}

function judgeOwnership(
  issuedBy: unknown,
  boundController: string | null,
): UpdateCommandVerdict | null {
  // Stricter than gpio/set: replacing code can wait the few seconds until the first heartbeat binds.
  if (boundController === null) {
    return logOnly('no controller is bound yet');
  }
  if (issuedBy !== boundController) {
    return alarm(
      `issuedBy ${JSON.stringify(issuedBy)} is not the bound controller "${boundController}"`,
      AlarmCode.ControllerConflict,
    );
  }
  return null;
}

function judgeExpiry(
  expiresAt: unknown,
  now: Date,
): UpdateCommandVerdict | null {
  if (typeof expiresAt !== 'string') {
    return logOnly('update has no expiresAt');
  }
  const deadline = new Date(expiresAt);
  if (!ISO_8601_INSTANT.test(expiresAt) || Number.isNaN(deadline.getTime())) {
    return logOnly(`unparseable expiresAt "${expiresAt}"`);
  }
  if (deadline < now) {
    return alarm('update expired', AlarmCode.CommandExpired);
  }
  return null;
}

function describeTargetProblem(
  body: Record<string, unknown>,
  runningApp: AgentApp,
): string | null {
  const { app, version, manifestUrl, manifestSha256 } = body;
  if (!AGENT_APPS.has(app)) {
    return `unknown app ${JSON.stringify(app)}`;
  }
  if (app !== runningApp) {
    return `update is for ${String(app)}, this node runs ${runningApp}`;
  }
  const versionMajor =
    typeof version === 'string' ? readVersionMajor(version) : null;
  if (versionMajor === null) {
    return `unparseable version ${JSON.stringify(version)}`;
  }
  if (versionMajor !== MQTT_CONTRACT_MAJOR) {
    return `version ${String(version)} is for contract major ${versionMajor}, this node speaks ${MQTT_CONTRACT_MAJOR}`;
  }
  if (!isFetchableUrl(manifestUrl)) {
    return `manifestUrl ${JSON.stringify(manifestUrl)} is not an http(s) URL`;
  }
  if (typeof manifestSha256 !== 'string' || !SHA256_HEX.test(manifestSha256)) {
    return 'manifestSha256 is not 64 lowercase hex digits';
  }
  return null;
}

function isFetchableUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return MANIFEST_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function logOnly(reason: string): UpdateCommandVerdict {
  return { isAccepted: false, answer: 'log', reason };
}

function alarm(reason: string, alarmCode: AlarmCode): UpdateCommandVerdict {
  return { isAccepted: false, answer: 'alarm', reason, alarm: alarmCode };
}
