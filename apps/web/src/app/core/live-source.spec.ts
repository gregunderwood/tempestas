import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import { fakeRealtime, type FakeRealtime } from '../testing/fake-realtime';
import {
  REQUEST_TIMEOUT_MILLISECONDS,
  injectLiveSource,
  type LiveSource,
} from './live-source';
import { RealtimeService } from './realtime.service';

interface StartedSource {
  source: LiveSource<string>;
  realtime: FakeRealtime;
}

function startSource(
  request: () => Observable<string>,
  hasPushedData?: () => boolean,
): StartedSource {
  const realtime = fakeRealtime();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const source = TestBed.runInInjectionContext(() =>
    injectLiveSource(request, hasPushedData),
  );
  TestBed.tick();
  return { source, realtime };
}

function reconnect(realtime: FakeRealtime): void {
  realtime.reconnectCount.update((count) => count + 1);
  TestBed.tick();
}

const offline = (): Observable<string> =>
  throwError(() => new Error('offline'));

describe('injectLiveSource', () => {
  it('is loading until the first response, then loaded', () => {
    const response = new Subject<string>();
    const { source } = startSource(() => response);
    expect(source.sourceState()).toBe('loading');
    response.next('first');
    expect(source.sourceState()).toBe('loaded');
    expect(source.latest()?.response).toBe('first');
  });

  it('has failed when the first request fails', () => {
    const { source } = startSource(offline);
    expect(source.sourceState()).toBe('failed');
  });

  it('gives up on a request that never answers', () => {
    vi.useFakeTimers();
    const { source } = startSource(() => NEVER);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MILLISECONDS);
    expect(source.sourceState()).toBe('failed');
    vi.useRealTimers();
  });

  it('keeps the last response but calls it out of date when a refresh fails', () => {
    const responses = [of('first'), offline()];
    const { source } = startSource(() => responses.shift() ?? NEVER);
    source.refresh();
    expect(source.sourceState()).toBe('out-of-date');
    expect(source.latest()?.response).toBe('first');
  });

  it('fetches again on every reconnect, and the new response is used', () => {
    const responses = ['before the drop', 'after the drop'];
    const request = vi.fn(() => of(responses.shift() ?? ''));
    const { source, realtime } = startSource(request);
    reconnect(realtime);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.latest()?.response).toBe('after the drop');
  });

  it('recovers from a failed first load on reconnect', () => {
    const responses = [offline(), of('recovered')];
    const { source, realtime } = startSource(() => responses.shift() ?? NEVER);
    expect(source.sourceState()).toBe('failed');
    reconnect(realtime);
    expect(source.sourceState()).toBe('loaded');
  });

  it('ignores an older response that arrives after a newer one', () => {
    const slowRequest = new Subject<string>();
    const fastRequest = new Subject<string>();
    const requests = [slowRequest, fastRequest];
    const { source } = startSource(() => requests.shift() ?? NEVER);
    source.refresh();
    fastRequest.next('newer');
    slowRequest.next('older');
    expect(source.latest()?.response).toBe('newer');
  });

  it('counts data pushed over the socket as loaded while the request is out', () => {
    const hasPushedData = signal(false);
    const { source } = startSource(() => NEVER, hasPushedData);
    expect(source.sourceState()).toBe('loading');
    hasPushedData.set(true);
    expect(source.sourceState()).toBe('loaded');
  });
});
