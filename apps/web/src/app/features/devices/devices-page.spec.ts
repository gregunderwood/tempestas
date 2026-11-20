import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError, type Observable } from 'rxjs';
import type { Device } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { fakeRealtime } from '../../testing/fake-realtime';
import { device } from '../zones/zone-fixtures';
import { DevicesPage } from './devices-page';

describe('DevicesPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the devices but says so when refreshing them after a switch fails', () => {
    const answers: Observable<Device[]>[] = [
      of([device()]),
      throwError(() => new Error('offline')),
    ];
    TestBed.configureTestingModule({
      imports: [DevicesPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiService,
          useValue: {
            devices: () => answers.shift() ?? of([]),
            turnOn: () => of(undefined),
          },
        },
        { provide: RealtimeService, useValue: fakeRealtime() },
      ],
    });
    const fixture = TestBed.createComponent(DevicesPage);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;

    fixture.componentInstance.on(device());
    TestBed.tick();
    fixture.detectChanges();

    expect(page.textContent).toContain('Heater');
    expect(page.textContent).toContain(
      'Could not refresh the devices; the states below may be out of date.',
    );
  });
});
