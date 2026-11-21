import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { EMPTY, catchError } from 'rxjs';
import type { Device, RulesCycle } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import type { NumberedPush, PushedDevice } from '../../core/device-pushes';
import { RealtimeService } from '../../core/realtime.service';
import { MILLISECONDS_PER_SECOND } from '../../shared/time';
import {
  describeDecision,
  describeDispatch,
  labelRole,
} from '../zones/zone-words';
import { isOwnedDecision } from './system-summary';

export const ACTIVITY_LOG_LENGTH = 30;
const RECENT_SWITCH_SECONDS = 60;

export type ActivityKind = 'switch' | 'decision' | 'failure';

export interface ActivityEvent {
  at: string;
  kind: ActivityKind;
  text: string;
}

export interface ActivityEntry extends ActivityEvent {
  id: number;
}

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  switch: 'Relay',
  decision: 'Rules',
  failure: 'Failed',
};

@Injectable({ providedIn: 'root' })
export class ActivityLog {
  private readonly realtime = inject(RealtimeService);

  readonly entries = signal<readonly ActivityEntry[]>([]);

  private readonly knownDeviceStates = new Map<string, boolean>();
  private lastRecordedSequence = 0;
  private previousCycle: RulesCycle | null = null;
  private nextEntryId = 1;

  constructor() {
    inject(ApiService)
      .devices({ isBackground: true })
      .pipe(catchError(() => EMPTY))
      .subscribe((devices) => this.learnDeviceStates(devices));
    effect(() => {
      const recentPushes = this.realtime.recentDevicePushes();
      untracked(() => this.recordSwitches(recentPushes));
    });
    effect(() => {
      const cycle = this.realtime.latestRulesCycle();
      untracked(() => this.recordCycle(cycle));
    });
  }

  private recordSwitches(recentPushes: readonly NumberedPush[]): void {
    const unrecordedPushes = recentPushes.filter(
      (push) => push.sequence > this.lastRecordedSequence,
    );
    for (const push of unrecordedPushes) {
      const wasOn = this.knownDeviceStates.get(push.device.id);
      const switchEvent = describeSwitch(wasOn, push);
      if (switchEvent) this.append([switchEvent]);
      this.knownDeviceStates.set(push.device.id, push.device.isOn);
      this.lastRecordedSequence = push.sequence;
    }
  }

  /** A push that beat the list here is newer than the list, so it stands. */
  private learnDeviceStates(devices: readonly Device[]): void {
    for (const device of devices) {
      if (!this.knownDeviceStates.has(device.id)) {
        this.knownDeviceStates.set(device.id, device.isOn);
      }
    }
  }

  private recordCycle(cycle: RulesCycle | null): void {
    if (cycle === null) {
      this.previousCycle = null;
      return;
    }
    const isNewCycle = cycle.at !== this.previousCycle?.at;
    if (!isNewCycle) return;
    this.append(describeCycleChanges(this.previousCycle, cycle));
    this.previousCycle = cycle;
  }

  private append(events: readonly ActivityEvent[]): void {
    if (events.length === 0) return;
    const newEntries = events.map((event) => ({
      ...event,
      id: this.nextEntryId++,
    }));
    this.entries.update((entries) =>
      [...newEntries.reverse(), ...entries].slice(0, ACTIVITY_LOG_LENGTH),
    );
  }
}

export function describeSwitch(
  wasOn: boolean | undefined,
  push: PushedDevice,
): ActivityEvent | null {
  const { device } = push;
  const switchedAt = (device.isOn ? device.onAt : device.offAt) ?? null;
  const hasSwitched =
    wasOn === undefined
      ? hasSwitchedRecently(switchedAt, push.receivedAt)
      : wasOn !== device.isOn;
  if (!hasSwitched) return null;
  return {
    at: switchedAt ?? new Date(push.receivedAt).toISOString(),
    kind: 'switch',
    text: `${device.name} switched ${describeRelayState(device)}`,
  };
}

export function describeCycleChanges(
  previous: RulesCycle | null,
  current: RulesCycle,
): ActivityEvent[] {
  return [
    ...describeNewFailures(previous, current),
    ...(previous ? describeChangedDecisions(previous, current) : []),
    ...describeNewFailedDispatches(previous, current),
  ];
}

function describeChangedDecisions(
  previous: RulesCycle,
  current: RulesCycle,
): ActivityEvent[] {
  return current.evaluations.flatMap((evaluation) => {
    const before = previous.evaluations.find(
      (candidate) => candidate.zoneSlug === evaluation.zoneSlug,
    );
    return evaluation.decisions
      .filter(isOwnedDecision)
      .filter((decision) => {
        const previousDecision = before?.decisions.find(
          (candidate) => candidate.role === decision.role,
        );
        return (
          previousDecision?.desired !== decision.desired ||
          previousDecision?.reason !== decision.reason
        );
      })
      .map((decision) => ({
        at: evaluation.evaluatedAt,
        kind: 'decision' as const,
        text: `${evaluation.zoneSlug} ${labelRole(decision.role)}: ${describeDecision(decision)}`,
      }));
  });
}

function describeNewFailures(
  previous: RulesCycle | null,
  current: RulesCycle,
): ActivityEvent[] {
  const failingBefore = new Set(
    previous?.failingZones.map((failure) => failure.zoneSlug) ?? [],
  );
  return current.failingZones
    .filter((failure) => !failingBefore.has(failure.zoneSlug))
    .map((failure) => ({
      at: current.at,
      kind: 'failure' as const,
      text: `${failure.zoneSlug}: rules failed, ${failure.reason}`,
    }));
}

function describeNewFailedDispatches(
  previous: RulesCycle | null,
  current: RulesCycle,
): ActivityEvent[] {
  const failedBefore = new Set(
    listFailedDispatches(previous).map((failed) => failed.key),
  );
  return listFailedDispatches(current)
    .filter((failed) => !failedBefore.has(failed.key))
    .map((failed) => failed.event);
}

function listFailedDispatches(cycle: RulesCycle | null) {
  return (cycle?.evaluations ?? []).flatMap((evaluation) =>
    evaluation.decisions.flatMap((decision) =>
      decision.dispatched
        .filter((dispatch) => dispatch.outcome === 'failed')
        .map((dispatch) => ({
          key: `${evaluation.zoneSlug}/${decision.role}/${dispatch.deviceId}`,
          event: {
            at: evaluation.evaluatedAt,
            kind: 'failure' as const,
            text: `${dispatch.deviceName}: ${describeDispatch(dispatch)}`,
          },
        })),
    ),
  );
}

function hasSwitchedRecently(
  switchedAt: string | null,
  receivedAt: number,
): boolean {
  if (!switchedAt) return false;
  const secondsBeforePush =
    (receivedAt - Date.parse(switchedAt)) / MILLISECONDS_PER_SECOND;
  return secondsBeforePush <= RECENT_SWITCH_SECONDS;
}

function describeRelayState(device: Device): string {
  return device.isOn ? 'ON' : 'off';
}
