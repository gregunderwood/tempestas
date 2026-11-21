import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import type { Device } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { fakeRealtime, pushDevice } from '../../testing/fake-realtime';
import {
  NOW,
  cycleOf,
  device,
  pumphouseEvaluation,
} from '../zones/zone-fixtures';
import {
  ACTIVITY_LOG_LENGTH,
  ActivityLog,
  describeCycleChanges,
  describeSwitch,
} from './activity-log';

const MINUTE_MILLISECONDS = 60_000;

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * MINUTE_MILLISECONDS).toISOString();
}

function startLog(knownDevices: Device[] = []) {
  const realtime = fakeRealtime();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RealtimeService, useValue: realtime },
      { provide: ApiService, useValue: { devices: () => of(knownDevices) } },
    ],
  });
  return { log: TestBed.inject(ActivityLog), realtime };
}

describe('describeSwitch', () => {
  it('reports a device whose state changed since the last push', () => {
    const push = { device: device({ isOn: true }), receivedAt: NOW.getTime() };
    expect(describeSwitch(false, push)?.text).toBe('Heater switched ON');
  });

  it('ignores a push that repeats the known state', () => {
    const push = { device: device({ isOn: true }), receivedAt: NOW.getTime() };
    expect(describeSwitch(true, push)).toBeNull();
  });

  it('reports a device first seen just after it switched', () => {
    const push = {
      device: device({ isOn: false, offAt: minutesAgo(0.5) }),
      receivedAt: NOW.getTime(),
    };
    expect(describeSwitch(undefined, push)?.at).toBe(minutesAgo(0.5));
  });

  it('does not call an old switch news on first sight', () => {
    const push = {
      device: device({ isOn: true, onAt: minutesAgo(30) }),
      receivedAt: NOW.getTime(),
    };
    expect(describeSwitch(undefined, push)).toBeNull();
  });
});

describe('ActivityLog', () => {
  it(`keeps only the newest ${ACTIVITY_LOG_LENGTH} entries`, () => {
    const { log, realtime } = startLog();
    const switchCount = ACTIVITY_LOG_LENGTH + 5;
    for (let switchNumber = 1; switchNumber <= switchCount; switchNumber++) {
      pushDevice(realtime, device({ isOn: switchNumber % 2 === 0 }));
      TestBed.tick();
    }
    expect(log.entries()).toHaveLength(ACTIVITY_LOG_LENGTH);
    expect(log.entries()[0].text).toBe('Heater switched off');
    expect(log.entries()[0].id).toBeGreaterThan(log.entries()[1].id);
  });
});

describe('describeCycleChanges', () => {
  function cycleWithFailedHeater() {
    const evaluation = pumphouseEvaluation();
    evaluation.decisions[0] = {
      ...evaluation.decisions[0],
      dispatched: [
        {
          deviceId: 'd-heater',
          deviceName: 'Heater',
          outcome: 'failed',
          detail: 'NODE_OFFLINE',
        },
      ],
    };
    return cycleOf([evaluation]);
  }

  it('reports a failed dispatch the first time it fails', () => {
    const changes = describeCycleChanges(
      cycleOf([pumphouseEvaluation()]),
      cycleWithFailedHeater(),
    );
    expect(changes.map((change) => change.text)).toEqual([
      'Heater: FAILED: NODE_OFFLINE',
    ]);
  });

  it('does not repeat a failure that is still failing', () => {
    expect(
      describeCycleChanges(cycleWithFailedHeater(), cycleWithFailedHeater()),
    ).toEqual([]);
  });
});

describe('ActivityLog switches', () => {
  it('records both switches when two arrive between reads', () => {
    const { log, realtime } = startLog();
    pushDevice(realtime, device({ isOn: false }));
    TestBed.tick();

    pushDevice(realtime, device({ isOn: true }));
    pushDevice(realtime, device({ isOn: false }));
    TestBed.tick();

    expect(log.entries().map((entry) => entry.text)).toEqual([
      'Heater switched off',
      'Heater switched ON',
    ]);
  });
});

describe('ActivityLog at start', () => {
  // The switch time is the controller's clock and a phone's can be minutes out.
  it("records a relay's first switch however far the phone's clock is out", () => {
    const { log, realtime } = startLog([device({ isOn: false })]);
    pushDevice(realtime, device({ isOn: true, onAt: minutesAgo(30) }));
    TestBed.tick();
    expect(log.entries().map((entry) => entry.text)).toEqual([
      'Heater switched ON',
    ]);
  });

  it('records nothing for a relay that is as the list left it', () => {
    const { log, realtime } = startLog([device({ isOn: true })]);
    pushDevice(realtime, device({ isOn: true, onAt: minutesAgo(30) }));
    TestBed.tick();
    expect(log.entries()).toEqual([]);
  });
});

describe('ActivityLog across a spell as follower', () => {
  it('compares nothing with the cycle from before the server stopped leading', () => {
    const { log, realtime } = startLog();
    realtime.latestRulesCycle.set(cycleOf([pumphouseEvaluation()]));
    TestBed.tick();
    realtime.latestRulesCycle.set(null);
    TestBed.tick();

    const heating = pumphouseEvaluation();
    heating.decisions[0] = {
      ...heating.decisions[0],
      desired: 'on',
      reason: 'temp-below-setpoint',
    };
    realtime.latestRulesCycle.set({
      ...cycleOf([heating]),
      at: minutesAgo(-1),
    });
    TestBed.tick();
    expect(log.entries()).toEqual([]);
  });
});
