import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, throwError } from 'rxjs';
import { ApiErrorCode, type ApiError } from '@tempestas/domain';
import { IS_BACKGROUND_REQUEST } from './background-request';

/**
 * One place that turns a failed request into something the operator can see.
 *
 * The old client had none: the API returned `{ error: "..." }` inside HTTP 200
 * bodies, so there were four near-identical `if (res.error)` blocks scattered
 * through components, no `catchError` anywhere, and a failure that did not match
 * one of those four shapes simply vanished. Real status codes plus this
 * interceptor is the whole fix.
 */
export const apiErrorInterceptor: HttpInterceptorFn = (request, next) => {
  const snackBar = inject(MatSnackBar);

  return next(request).pipe(
    catchError((error: HttpErrorResponse) => {
      // A background retry fails every few seconds while the Pi is down; the page already says so.
      if (!request.context.get(IS_BACKGROUND_REQUEST)) {
        snackBar.open(messageFor(error), 'Dismiss', {
          duration: durationFor(error),
          panelClass: 'tempestas-error-snack',
        });
      }
      return throwError(() => error);
    }),
  );
};

/**
 * Prefer the server's own words. Every error it raises carries a machine
 * readable `code` and a message written for a human; inventing a friendlier one
 * here would just hide which of them happened.
 */
export function messageFor(error: HttpErrorResponse): string {
  const body = error.error as Partial<ApiError> | string | null;

  if (error.status === 0) {
    // Not a server error at all - the Pi is unreachable, which on a home LAN is
    // the common case and deserves saying plainly.
    return 'Cannot reach the controller. Check that it is powered and on the network.';
  }
  if (body && typeof body === 'object' && typeof body.message === 'string') {
    return body.message;
  }
  return `Request failed (HTTP ${error.status})`;
}

/**
 * A refusal the operator caused is transient; a failure of the system is not.
 * A cooldown message that vanishes before it is read is a bug report waiting to
 * happen.
 */
function durationFor(error: HttpErrorResponse): number {
  const code = (error.error as Partial<ApiError> | null)?.code;
  const expected =
    code === ApiErrorCode.DeviceAlreadyOn ||
    code === ApiErrorCode.DeviceAlreadyOff ||
    code === ApiErrorCode.DeviceCooldown;
  return expected ? 6000 : 12000;
}
