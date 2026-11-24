import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { appRoutes } from './app.routes';
import { RealtimeService } from './core/realtime.service';
import { fakeRealtime } from './testing/fake-realtime';

async function landingUrlFor(url: string): Promise<string> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(appRoutes),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RealtimeService, useValue: fakeRealtime() },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return TestBed.inject(Router).url;
}

describe('appRoutes', () => {
  it('opens the reports screen', async () => {
    expect(await landingUrlFor('/reports')).toBe('/reports');
  });

  it('sends an old readings bookmark to the reports screen', async () => {
    expect(await landingUrlFor('/readings')).toBe('/reports');
  });
});
