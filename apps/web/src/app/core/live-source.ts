import {
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { timeout, type Observable } from 'rxjs';
import { RealtimeService } from './realtime.service';

export const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

export type SourceState = 'loading' | 'loaded' | 'out-of-date' | 'failed';

export interface FetchedResponse<Response> {
  response: Response;
  requestedAt: number;
}

export interface LiveSource<Response> {
  latest: Signal<FetchedResponse<Response> | null>;
  sourceState: Signal<SourceState>;
  refresh(): void;
}

export function injectLiveSource<Response>(
  request: () => Observable<Response>,
  hasPushedData: () => boolean = () => false,
): LiveSource<Response> {
  const requests = new SourceRequests(request);
  const refresh = (): void => requests.send();
  refresh();
  refreshOnEveryReconnect(inject(RealtimeService), refresh);

  return {
    latest: requests.latest,
    sourceState: computed(() =>
      describeSourceState(
        requests.latest() !== null || hasPushedData(),
        requests.hasNewestRequestFailed(),
      ),
    ),
    refresh,
  };
}

function describeSourceState(
  hasData: boolean,
  hasNewestRequestFailed: boolean,
): SourceState {
  if (hasData) return hasNewestRequestFailed ? 'out-of-date' : 'loaded';
  return hasNewestRequestFailed ? 'failed' : 'loading';
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

class SourceRequests<Response> {
  readonly latest = signal<FetchedResponse<Response> | null>(null);
  readonly hasNewestRequestFailed = signal(false);
  private requestsSent = 0;
  private newestAnsweredRequest = 0;

  constructor(private readonly request: () => Observable<Response>) {}

  send(): void {
    this.requestsSent += 1;
    const requestNumber = this.requestsSent;
    const requestedAt = Date.now();
    this.request()
      .pipe(timeout(REQUEST_TIMEOUT_MILLISECONDS))
      .subscribe({
        next: (response) =>
          this.acceptResponse(requestNumber, { response, requestedAt }),
        error: () => this.recordFailure(requestNumber),
      });
  }

  private acceptResponse(
    requestNumber: number,
    fetched: FetchedResponse<Response>,
  ): void {
    if (requestNumber < this.newestAnsweredRequest) return;
    this.newestAnsweredRequest = requestNumber;
    this.latest.set(fetched);
    if (this.isNewest(requestNumber)) this.hasNewestRequestFailed.set(false);
  }

  private recordFailure(requestNumber: number): void {
    if (this.isNewest(requestNumber)) this.hasNewestRequestFailed.set(true);
  }

  private isNewest(requestNumber: number): boolean {
    return requestNumber === this.requestsSent;
  }
}
