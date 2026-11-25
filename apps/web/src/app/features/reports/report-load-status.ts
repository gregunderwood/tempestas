import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { SourceState } from '../../core/live-source';

@Component({
  selector: 'temp-report-load-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div aria-live="polite">
      @switch (state()) {
        @case ('loading') {
          <p class="temp-muted">Loading {{ subject() }}…</p>
        }
        @case ('failed') {
          <p class="temp-alert">Could not load the {{ subject() }}.</p>
        }
        @case ('out-of-date') {
          <p class="temp-alert">
            Could not refresh the {{ subject() }}; the figures below may be out
            of date.
          </p>
        }
      }
    </div>
  `,
  styles: `
    .temp-alert {
      color: var(--temp-gauge-red);
    }
    .temp-muted {
      opacity: 0.7;
      font-size: 0.85rem;
    }
  `,
})
export class ReportLoadStatus {
  readonly state = input.required<SourceState>();
  readonly subject = input.required<string>();
}
