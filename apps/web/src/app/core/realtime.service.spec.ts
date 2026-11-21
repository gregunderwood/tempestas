import type { SystemStatus } from '@tempestas/domain';
import { measureServerClockOffset } from './realtime.service';

const SENT_AT = '2026-11-20T21:14:00.000Z';

function statusSentAt(sentAt: string): SystemStatus {
  return {
    at: '2026-11-20T21:13:55.000Z',
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 1,
    nodesTotal: 1,
    nodesPending: 0,
    isLeading: true,
    lastEvaluationAt: '2026-11-20T21:13:55.000Z',
    sentAt,
  };
}

describe('measureServerClockOffset', () => {
  it('is negative when the browser clock runs ahead of the server', () => {
    const receivedAt = Date.parse(SENT_AT) + 300_000;
    expect(measureServerClockOffset(statusSentAt(SENT_AT), receivedAt)).toBe(
      -300_000,
    );
  });

  it('is positive when the browser clock runs behind the server', () => {
    const receivedAt = Date.parse(SENT_AT) - 300_000;
    expect(measureServerClockOffset(statusSentAt(SENT_AT), receivedAt)).toBe(
      300_000,
    );
  });
});
