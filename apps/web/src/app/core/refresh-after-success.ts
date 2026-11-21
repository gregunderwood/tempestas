import type { Observable } from 'rxjs';

// A failure is swallowed here because the API error interceptor has already reported it.
export function refreshAfterSuccess(
  request: Observable<unknown>,
  refresh: () => void,
): void {
  request.subscribe({ next: () => refresh(), error: () => undefined });
}
