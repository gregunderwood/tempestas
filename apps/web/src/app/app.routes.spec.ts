import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { appRoutes } from './app.routes';

async function landingUrlFor(url: string): Promise<string> {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter(appRoutes)],
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
