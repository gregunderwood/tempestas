import { REALTIME_EVENTS, type SystemStatus } from '@tempestas/domain';
import { measureServerClockOffset, RealtimeService } from './realtime.service';

const fakeSocket = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    on(event: string, handler: (payload: unknown) => void) {
      handlers.set(event, handler);
    },
    close() {
      handlers.clear();
    },
    emitFromServer(event: string, payload: unknown) {
      handlers.get(event)?.(payload);
    },
  };
});

vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

const SENT_AT = '2026-11-20T21:14:00.000Z';
const FIVE_MINUTES_MILLISECONDS = 300_000;

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
    const receivedAt = Date.parse(SENT_AT) + FIVE_MINUTES_MILLISECONDS;
    expect(measureServerClockOffset(statusSentAt(SENT_AT), receivedAt)).toBe(
      -FIVE_MINUTES_MILLISECONDS,
    );
  });

  it('is positive when the browser clock runs behind the server', () => {
    const receivedAt = Date.parse(SENT_AT) - FIVE_MINUTES_MILLISECONDS;
    expect(measureServerClockOffset(statusSentAt(SENT_AT), receivedAt)).toBe(
      FIVE_MINUTES_MILLISECONDS,
    );
  });

  it('is zero when the status has no readable sentAt', () => {
    const statusFromOlderServer = {
      ...statusSentAt(SENT_AT),
      sentAt: undefined,
    } as unknown as SystemStatus;
    expect(
      measureServerClockOffset(statusFromOlderServer, Date.parse(SENT_AT)),
    ).toBe(0);
  });
});

describe('RealtimeService', () => {
  let realtime: RealtimeService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(SENT_AT));
    realtime = new RealtimeService();
    realtime.connect();
  });

  afterEach(() => {
    realtime.ngOnDestroy();
    vi.useRealTimers();
  });

  it('measures the server clock offset from a received status', () => {
    const sentAtFiveMinutesAhead = new Date(
      Date.now() + FIVE_MINUTES_MILLISECONDS,
    ).toISOString();

    fakeSocket.emitFromServer(
      REALTIME_EVENTS.systemStatus,
      statusSentAt(sentAtFiveMinutesAhead),
    );

    expect(realtime.serverClockOffsetMilliseconds()).toBe(
      FIVE_MINUTES_MILLISECONDS,
    );
  });
});
