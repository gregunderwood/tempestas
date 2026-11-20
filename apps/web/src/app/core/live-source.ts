import {
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timeout, type Observable } from 'rxjs';
import { RealtimeService } from './realtime.service';

export const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const RETRY_AFTER_FAILURE_MILLISECONDS = 10_000;

export type SourceState = 'loading' | 'loaded' | 'out-of-date' | 'failed';

export interface FetchedPayload<Payload> {
  payload: Payload;
  requestedAt: number;
}

export interface LiveSource<Payload> {
  latest: Signal<FetchedPayload<Payload> | null>;
  sourceState: Signal<SourceState>;
  refresh(): void;
}

export function injectLiveSource<Payload>(
  request: () => Observable<Payload>,
  hasPushedSnapshot: () => boolean = () => false,
): LiveSource<Payload> {
  const requests = new SourceRequests(request, inject(DestroyRef));
  const refresh = (): void => requests.send();
  refresh();
  refreshOnEveryReconnect(inject(RealtimeService), refresh);

  return {
    latest: requests.latest,
    sourceState: computed(() =>
      describeSourceState({
        hasPushedSnapshot: hasPushedSnapshot(),
        hasFetchedPayload: requests.latest() !== null,
        hasNewestRequestFailed: requests.hasNewestRequestFailed(),
      }),
    ),
    refresh,
  };
}

interface SourceFacts {
  hasPushedSnapshot: boolean;
  hasFetchedPayload: boolean;
  hasNewestRequestFailed: boolean;
}

function describeSourceState(facts: SourceFacts): SourceState {
  if (facts.hasPushedSnapshot) return 'loaded';
  if (facts.hasFetchedPayload) {
    return facts.hasNewestRequestFailed ? 'out-of-date' : 'loaded';
  }
  return facts.hasNewestRequestFailed ? 'failed' : 'loading';
}

// A change made while the socket was down is only seen by fetching again.
function refreshOnEveryReconnect(
  realtime: RealtimeService,
  refresh: () => void,
): void {
  const reconnectsAtStart = realtime.reconnectCount();
  effect(() => {
    if (realtime.reconnectCount() > reconnectsAtStart) untracked(refresh);
  });
}

class SourceRequests<Payload> {
  readonly latest = signal<FetchedPayload<Payload> | null>(null);
  readonly hasNewestRequestFailed = signal(false);
  private requestsSent = 0;
  private newestAnsweredRequest = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly request: () => Observable<Payload>,
    private readonly destroyRef: DestroyRef,
  ) {
    destroyRef.onDestroy(() => clearTimeout(this.retryTimer));
  }

  send(): void {
    clearTimeout(this.retryTimer);
    this.requestsSent += 1;
    const requestNumber = this.requestsSent;
    const requestedAt = Date.now();
    this.request()
      .pipe(
        timeout(REQUEST_TIMEOUT_MILLISECONDS),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (payload) =>
          this.acceptPayload(requestNumber, { payload, requestedAt }),
        error: () => this.recordFailure(requestNumber),
      });
  }

  private acceptPayload(
    requestNumber: number,
    fetched: FetchedPayload<Payload>,
  ): void {
    if (requestNumber < this.newestAnsweredRequest) return;
    this.newestAnsweredRequest = requestNumber;
    this.latest.set(fetched);
    if (this.isNewest(requestNumber)) this.hasNewestRequestFailed.set(false);
  }

  private recordFailure(requestNumber: number): void {
    if (!this.isNewest(requestNumber)) return;
    this.hasNewestRequestFailed.set(true);
    this.retryTimer = setTimeout(
      () => this.send(),
      RETRY_AFTER_FAILURE_MILLISECONDS,
    );
  }

  private isNewest(requestNumber: number): boolean {
    return requestNumber === this.requestsSent;
  }
}
