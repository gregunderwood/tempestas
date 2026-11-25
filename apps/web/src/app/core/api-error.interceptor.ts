import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, throwError } from 'rxjs';
import { ApiErrorCode, type ApiError } from '@tempestas/domain';
import { IS_BACKGROUND_REQUEST } from './background-request';

const DISMISS_ACTION = 'Dismiss';
const ERROR_SNACK_CLASS = 'tempestas-error-snack';
const EXPECTED_REFUSAL_SHOWN_MILLISECONDS = 6000;
const UNEXPECTED_FAILURE_SHOWN_MILLISECONDS = 12000;
const UNREACHABLE_STATUS = 0;
const UNREACHABLE_MESSAGE =
  'Cannot reach the controller. Check that it is powered and on the network.';

const EXPECTED_REFUSAL_CODES: ReadonlySet<ApiErrorCode> = new Set([
  ApiErrorCode.DeviceAlreadyOn,
  ApiErrorCode.DeviceAlreadyOff,
  ApiErrorCode.DeviceCooldown,
]);

export const apiErrorInterceptor: HttpInterceptorFn = (request, next) => {
  const snackBar = inject(MatSnackBar);

  return next(request).pipe(
    catchError((error: HttpErrorResponse) => {
      // A background retry fails every few seconds while the Pi is down; the page already says so.
      if (!request.context.get(IS_BACKGROUND_REQUEST)) {
        snackBar.open(describeRequestFailure(error), DISMISS_ACTION, {
          duration: chooseShownDuration(error),
          panelClass: ERROR_SNACK_CLASS,
        });
      }
      return throwError(() => error);
    }),
  );
};

export function describeRequestFailure(error: HttpErrorResponse): string {
  if (isControllerUnreachable(error)) return UNREACHABLE_MESSAGE;
  const body = error.error as Partial<ApiError> | string | null;
  if (hasServerMessage(body)) return body.message;
  if (hasValidationMessages(body)) return body.message.join('; ');
  return `Request failed (HTTP ${error.status})`;
}

// Nest's validation pipe answers with one message per refused field.
function hasValidationMessages(body: unknown): body is { message: string[] } {
  if (body === null || typeof body !== 'object') return false;
  const message = (body as { message?: unknown }).message;
  return (
    Array.isArray(message) && message.every((line) => typeof line === 'string')
  );
}

function isControllerUnreachable(error: HttpErrorResponse): boolean {
  return error.status === UNREACHABLE_STATUS;
}

function hasServerMessage(
  body: Partial<ApiError> | string | null,
): body is Partial<ApiError> & { message: string } {
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof body.message === 'string'
  );
}

function chooseShownDuration(error: HttpErrorResponse): number {
  return isExpectedRefusal(error)
    ? EXPECTED_REFUSAL_SHOWN_MILLISECONDS
    : UNEXPECTED_FAILURE_SHOWN_MILLISECONDS;
}

function isExpectedRefusal(error: HttpErrorResponse): boolean {
  const code = (error.error as Partial<ApiError> | null)?.code;
  return code !== undefined && EXPECTED_REFUSAL_CODES.has(code);
}
