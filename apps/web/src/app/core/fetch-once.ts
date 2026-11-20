import { signal, type Signal } from '@angular/core';
import type { Observable } from 'rxjs';

export type RequestState = 'loading' | 'loaded' | 'failed';

export interface FetchedOnce<Value> {
  value: Signal<Value | null>;
  requestState: Signal<RequestState>;
}

export function fetchOnce<Value>(
  request: Observable<Value>,
): FetchedOnce<Value> {
  const value = signal<Value | null>(null);
  const requestState = signal<RequestState>('loading');
  request.subscribe({
    next: (response) => {
      value.set(response);
      requestState.set('loaded');
    },
    error: () => requestState.set('failed'),
  });
  return { value, requestState };
}
