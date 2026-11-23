import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ReportsPage } from './reports-page';

function renderReportsPage(): HTMLElement {
  TestBed.configureTestingModule({
    imports: [ReportsPage],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(ReportsPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ReportsPage', () => {
  it('names every report that is coming', () => {
    const listed = Array.from(renderReportsPage().querySelectorAll('li')).map(
      (item) => item.textContent?.trim(),
    );
    expect(listed).toEqual([
      'Time in range',
      'Equipment runtime',
      'Freeze margin',
      'CO2 enrichment',
      'Node health',
    ]);
  });

  it('says there are no reports yet rather than showing an empty screen', () => {
    expect(renderReportsPage().textContent).toContain('No reports yet');
  });
});
