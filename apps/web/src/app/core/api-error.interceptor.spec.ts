import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideZonelessChangeDetection } from '@angular/core';
import { ApiErrorCode } from '@tempestas/domain';
import { apiErrorInterceptor, messageFor } from './api-error.interceptor';

describe('apiErrorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let opened: { message: string; config: unknown }[];

  beforeEach(() => {
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        {
          provide: MatSnackBar,
          useValue: {
            open: (message: string, _action: string, config: unknown) =>
              opened.push({ message, config }),
          },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  // THE phase 9 checkpoint: an induced 409 raises a snackbar.
  it('raises a snackbar carrying the server’s own message on a 409', () => {
    let failed: unknown = null;
    http.post('/api/devices/x/on', {}).subscribe({ error: (err) => (failed = err) });

    controller.expectOne('/api/devices/x/on').flush(
      { code: ApiErrorCode.DeviceCooldown, message: 'CO2 Generator is within its minimum-off time' },
      { status: 409, statusText: 'Conflict' },
    );

    expect(opened).toHaveLength(1);
    expect(opened[0].message).toBe('CO2 Generator is within its minimum-off time');
    // And the error still reaches the caller: the interceptor reports, it does
    // not swallow.
    expect(failed).toBeInstanceOf(HttpErrorResponse);
  });

  it('says plainly when the controller is unreachable', () => {
    http.get('/api/devices').subscribe({ error: () => undefined });
    controller.expectOne('/api/devices').error(new ProgressEvent('network'));

    expect(opened[0].message).toContain('Cannot reach the controller');
  });

  it('falls back to the status code when there is no usable body', () => {
    http.get('/api/nodes').subscribe({ error: () => undefined });
    controller.expectOne('/api/nodes').flush('boom', { status: 500, statusText: 'Server Error' });

    expect(opened[0].message).toBe('Request failed (HTTP 500)');
  });

  // A cooldown message that vanishes before it is read is a bug report waiting
  // to happen; a system failure deserves longer still.
  it('keeps an unexpected failure on screen longer than an expected refusal', () => {
    http.post('/api/devices/x/on', {}).subscribe({ error: () => undefined });
    controller
      .expectOne('/api/devices/x/on')
      .flush({ code: ApiErrorCode.DeviceAlreadyOn, message: 'already on' }, { status: 409, statusText: 'Conflict' });

    http.post('/api/devices/y/on', {}).subscribe({ error: () => undefined });
    controller
      .expectOne('/api/devices/y/on')
      .flush(
        { code: ApiErrorCode.HardwareUnreachable, message: 'node did not acknowledge' },
        { status: 503, statusText: 'Service Unavailable' },
      );

    const [expected, unexpected] = opened.map((o) => (o.config as { duration: number }).duration);
    expect(unexpected).toBeGreaterThan(expected);
  });
});

describe('messageFor', () => {
  it('prefers the server’s message over anything invented here', () => {
    const error = new HttpErrorResponse({
      status: 409,
      error: { code: ApiErrorCode.NodeNotAdmitted, message: 'Node "ghost" is pending' },
    });
    expect(messageFor(error)).toBe('Node "ghost" is pending');
  });
});
