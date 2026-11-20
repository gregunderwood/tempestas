import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import type { Device } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { fakeRealtime } from '../../testing/fake-realtime';
import { device } from '../zones/zone-fixtures';
import { DevicesPage } from './devices-page';

interface RenderedDevicesPage {
  page: HTMLElement;
  turnOnAndRender(switched: Device): void;
}

function renderDevicesPage(
  answers: Observable<Device[]>[],
): RenderedDevicesPage {
  TestBed.configureTestingModule({
    imports: [DevicesPage],
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ApiService,
        useValue: {
          devices: () => answers.shift() ?? NEVER,
          turnOn: () => of(undefined),
        },
      },
      { provide: RealtimeService, useValue: fakeRealtime() },
    ],
  });
  const fixture = TestBed.createComponent(DevicesPage);
  fixture.detectChanges();
  return {
    page: fixture.nativeElement as HTMLElement,
    turnOnAndRender: (switched) => {
      fixture.componentInstance.on(switched);
      TestBed.tick();
      fixture.detectChanges();
    },
  };
}

const offline = (): Observable<Device[]> =>
  throwError(() => new Error('offline'));

describe('DevicesPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says it could not load the devices when the first request fails', () => {
    const { page } = renderDevicesPage([offline()]);
    expect(page.textContent).toContain('Could not load the devices.');
  });

  it('keeps the devices but says so when refreshing them after a switch fails', () => {
    const { page, turnOnAndRender } = renderDevicesPage([
      of([device()]),
      offline(),
    ]);
    turnOnAndRender(device());
    expect(page.textContent).toContain('Heater');
    expect(page.textContent).toContain(
      'Could not refresh the devices; the states below may be out of date.',
    );
  });
});
