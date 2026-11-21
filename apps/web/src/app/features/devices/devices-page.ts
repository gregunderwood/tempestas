import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../../core/api.service';
import { injectLiveDevices } from '../../core/live-devices';
import type { Device } from '@tempestas/domain';
import type { Observable } from 'rxjs';
import { isHeldOffByInterlock } from './device-hold';

// No force-on here: it bypasses the burner's anti-short-cycle interlock.
@Component({
  selector: 'temp-devices-page',
  imports: [MatCardModule, MatButtonModule, MatSlideToggleModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div aria-live="polite">
      @switch (sourceState()) {
        @case ('failed') {
          <p class="temp-alert">Could not load the devices.</p>
        }
        @case ('out-of-date') {
          <p class="temp-alert">
            Could not refresh the devices; the states below may be out of date.
          </p>
        }
      }
    </div>
    <div class="temp-cards">
      @for (device of devices(); track device.id) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-card-title>{{ device.name }}</mat-card-title>
            <mat-card-subtitle
              >{{ device.nodeId }} · pin {{ device.gpio }}</mat-card-subtitle
            >
          </mat-card-header>
          <mat-card-content>
            <p>
              <strong>{{ device.isOn ? 'ON' : 'off' }}</strong>
            </p>
            @if (isHeldOffByInterlock(device)) {
              <p class="temp-muted">
                Cooling down until {{ device.canTurnOnAt }}
              </p>
            }
            <mat-slide-toggle
              [checked]="device.rulesEnabled"
              (change)="setRulesEnabled(device, $event.checked)"
            >
              Automation
            </mat-slide-toggle>
          </mat-card-content>
          <mat-card-actions>
            <button
              mat-button
              [disabled]="device.isOn"
              (click)="turnOn(device)"
            >
              Turn on
            </button>
            <button
              mat-button
              [disabled]="!device.isOn"
              (click)="turnOff(device)"
            >
              Turn off
            </button>
          </mat-card-actions>
        </mat-card>
      }
    </div>
  `,
  styles: `
    .temp-cards {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .temp-alert {
      color: var(--temp-gauge-red);
    }
    .temp-muted {
      opacity: 0.7;
      font-size: 0.85rem;
    }
  `,
})
export class DevicesPage {
  private readonly api = inject(ApiService);
  private readonly liveDevices = injectLiveDevices();
  readonly devices = this.liveDevices.devices;
  protected readonly sourceState = this.liveDevices.sourceState;
  protected readonly isHeldOffByInterlock = isHeldOffByInterlock;

  turnOn(device: Device): void {
    this.refreshAfterSuccess(this.api.turnOn(device.id));
  }

  turnOff(device: Device): void {
    this.refreshAfterSuccess(this.api.turnOff(device.id));
  }

  setRulesEnabled(device: Device, rulesEnabled: boolean): void {
    this.api
      .setRulesEnabled(device.id, rulesEnabled)
      .subscribe({ next: () => this.refresh(), error: () => this.refresh() });
  }

  private refreshAfterSuccess(request: Observable<unknown>): void {
    request.subscribe({ next: () => this.refresh(), error: () => undefined });
  }

  private refresh(): void {
    this.liveDevices.refresh();
  }
}
