import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  NO_DEVICES,
  withPushes,
  type FetchedDevices,
} from '../../core/device-pushes';
import type { Device } from '@tempestas/domain';

/**
 * Placeholder until phase 11, but the on/off buttons are real - they are what
 * the phase 9 checkpoint induces a 409 through.
 *
 * `force-on` is deliberately absent. It bypasses the anti-short-cycle interlock
 * on a propane burner, so it does not belong beside an ordinary toggle.
 */
@Component({
  selector: 'temp-devices-page',
  imports: [MatCardModule, MatButtonModule, MatSlideToggleModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Devices</h1>
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
            @if (!device.canTurnOn && !device.isOn && device.canTurnOnAt) {
              <p class="temp-muted">
                Cooling down until {{ device.canTurnOnAt }}
              </p>
            }
            <mat-slide-toggle
              [checked]="device.rulesEnabled"
              (change)="setRules(device, $event.checked)"
            >
              Automation
            </mat-slide-toggle>
          </mat-card-content>
          <mat-card-actions>
            <button mat-button [disabled]="device.isOn" (click)="on(device)">
              Turn on
            </button>
            <button mat-button [disabled]="!device.isOn" (click)="off(device)">
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
    .temp-muted {
      opacity: 0.7;
      font-size: 0.85rem;
    }
  `,
})
export class DevicesPage {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly fetched = signal<FetchedDevices>(NO_DEVICES);
  /** A pushed device state patches the list; it never becomes the list. */
  readonly devices = computed(() =>
    withPushes(this.fetched(), this.realtime.devicePushes()),
  );

  constructor() {
    this.refresh();
  }

  on(device: Device): void {
    this.api
      .turnOn(device.id)
      .subscribe({ next: () => this.refresh(), error: () => undefined });
  }

  off(device: Device): void {
    this.api
      .turnOff(device.id)
      .subscribe({ next: () => this.refresh(), error: () => undefined });
  }

  setRules(device: Device, rulesEnabled: boolean): void {
    this.api
      .setRulesEnabled(device.id, rulesEnabled)
      .subscribe({ next: () => this.refresh(), error: () => this.refresh() });
  }

  private refresh(): void {
    const requestedAt = Date.now();
    this.api
      .devices()
      .subscribe((devices) => this.fetched.set({ devices, requestedAt }));
  }
}
