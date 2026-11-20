import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  EnvironmentInjector,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import { fakeRealtime, type FakeRealtime } from '../testing/fake-realtime';
import {
  REQUEST_TIMEOUT_MILLISECONDS,
  RETRY_AFTER_FAILURE_MILLISECONDS,
  injectLiveSource,
  type LiveSource,
} from './live-source';
import { RealtimeService } from './realtime.service';

interface StartedSource {
  source: LiveSource<string>;
  realtime: FakeRealtime;
  closePage(): void;
}

function startSource(
  request: () => Observable<string>,
  hasPushedSnapshot?: () => boolean,
): StartedSource {
  const realtime = fakeRealtime();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const pageInjector = createEnvironmentInjector(
    [],
    TestBed.inject(EnvironmentInjector),
  );
  const source = runInInjectionContext(pageInjector, () =>
    injectLiveSource(request, hasPushedSnapshot),
  );
  TestBed.tick();
  return { source, realtime, closePage: () => pageInjector.destroy() };
}

function reconnect(realtime: FakeRealtime): void {
  realtime.reconnectCount.update((count) => count + 1);
  TestBed.tick();
}

const offline = (): Observable<string> =>
  throwError(() => new Error('offline'));

function answerInTurn(
  ...answers: Observable<string>[]
): () => Observable<string> {
  return () => answers.shift() ?? NEVER;
}

describe('injectLiveSource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is loading until the first response, then loaded', () => {
    const response = new Subject<string>();
    const { source } = startSource(() => response);
    expect(source.sourceState()).toBe('loading');
    response.next('first');
    expect(source.sourceState()).toBe('loaded');
    expect(source.latest()?.payload).toBe('first');
  });

  it('has failed when the first request fails', () => {
    const { source } = startSource(offline);
    expect(source.sourceState()).toBe('failed');
  });

  it('gives up on a request that never answers', () => {
    const { source } = startSource(() => NEVER);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MILLISECONDS);
    expect(source.sourceState()).toBe('failed');
  });

  it('tries a failed request again without waiting for a reconnect', () => {
    const { source } = startSource(answerInTurn(offline(), of('second try')));
    expect(source.sourceState()).toBe('failed');
    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MILLISECONDS);
    expect(source.sourceState()).toBe('loaded');
    expect(source.latest()?.payload).toBe('second try');
  });

  it('keeps the last response but calls it out of date when a refresh fails', () => {
    const { source } = startSource(answerInTurn(of('first'), offline()));
    source.refresh();
    expect(source.sourceState()).toBe('out-of-date');
    expect(source.latest()?.payload).toBe('first');
  });

  it('fetches again on every reconnect, and the new response is used', () => {
    const request = vi.fn(answerInTurn(of('before the drop'), of('after')));
    const { source, realtime } = startSource(request);
    reconnect(realtime);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.latest()?.payload).toBe('after');
  });

  it('ignores an older response that arrives after a newer one', () => {
    const slowRequest = new Subject<string>();
    const fastRequest = new Subject<string>();
    const { source } = startSource(answerInTurn(slowRequest, fastRequest));
    source.refresh();
    fastRequest.next('newer');
    slowRequest.next('older');
    expect(source.latest()?.payload).toBe('newer');
  });

  it('ignores an older request failing after a newer one answered', () => {
    const slowRequest = new Subject<string>();
    const { source } = startSource(answerInTurn(slowRequest, of('newer')));
    source.refresh();
    slowRequest.error(new Error('offline'));
    expect(source.sourceState()).toBe('loaded');
  });

  it('keeps an older answer arriving after a newer failure, still out of date', () => {
    const slowRequest = new Subject<string>();
    const { source } = startSource(answerInTurn(slowRequest, offline()));
    source.refresh();
    slowRequest.next('older');
    expect(source.latest()?.payload).toBe('older');
    expect(source.sourceState()).toBe('out-of-date');
  });

  it('counts a complete snapshot pushed over the socket as loaded, even after a failed request', () => {
    const hasPushedSnapshot = signal(false);
    const { source } = startSource(offline, hasPushedSnapshot);
    expect(source.sourceState()).toBe('failed');
    hasPushedSnapshot.set(true);
    expect(source.sourceState()).toBe('loaded');
  });

  it('stops fetching once its page has closed', () => {
    const request = vi.fn(offline);
    const { realtime, closePage } = startSource(request);
    closePage();
    reconnect(realtime);
    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MILLISECONDS);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
