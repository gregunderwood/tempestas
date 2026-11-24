import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { catchError, map, of } from 'rxjs';
import {
  DeviceRole,
  MAX_INPUT_BTU_PER_HOUR,
  type Device,
  type GpioLevel,
  type Node,
  type NodeId,
  type Zone,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { labelRole } from '../zones/zone-words';
import {
  buildCreatePayload,
  buildUpdatePayload,
  describeRemapping,
  emptyDeviceForm,
  exposesPins,
  listPinChoices,
  MIN_INPUT_BTU_PER_HOUR,
  MIN_ON_DELAY_SECONDS,
  ON_LEVEL_CHOICES,
  readDeviceForm,
  type CompleteDeviceFormValue,
  type DeviceFormValue,
} from './device-form';
import { requireNonBlank, requireWholeNumber } from './device-form-validators';

export interface DeviceFormDialogData {
  device: Device | null;
  devices: readonly Device[];
}

const DIALOG_WIDTH = '34rem';
const DIALOG_MAX_WIDTH = 'calc(100vw - 32px)';

export const DEVICE_FORM_DIALOG_SIZE = {
  width: DIALOG_WIDTH,
  maxWidth: DIALOG_MAX_WIDTH,
};

@Component({
  selector: 'temp-device-form-dialog',
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ title }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        <p class="temp-muted">Saving switches nothing.</p>

        <mat-form-field>
          <mat-label>Name</mat-label>
          <input matInput formControlName="name" />
          <mat-error>A device needs a name.</mat-error>
        </mat-form-field>

        @if (editedDevice) {
          <p class="temp-fixed">
            Node <strong>{{ editedDevice.nodeId }}</strong>
          </p>
        } @else {
          <mat-form-field>
            <mat-label>Node</mat-label>
            <mat-select formControlName="nodeId">
              @for (node of nodesWithPins(); track node.id) {
                <mat-option [value]="node.slug">{{
                  node.displayName
                }}</mat-option>
              }
            </mat-select>
            <mat-error>Choose the node the relay is wired to.</mat-error>
          </mat-form-field>
        }

        <mat-form-field>
          <mat-label>Zone</mat-label>
          <mat-select formControlName="zoneId">
            @if (!editedDevice) {
              <mat-option [value]="null">The node's zone</mat-option>
            }
            @for (zone of zones(); track zone.id) {
              <mat-option [value]="zone.id">{{ zone.displayName }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field>
          <mat-label>Role</mat-label>
          <mat-select formControlName="role">
            <mat-option [value]="null">None</mat-option>
            @for (role of roles; track role) {
              <mat-option [value]="role">{{ labelRole(role) }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field>
          <mat-label>GPIO pin</mat-label>
          <mat-select formControlName="gpio">
            @for (choice of pinChoices(); track choice.pin) {
              <mat-option
                [value]="choice.pin"
                [disabled]="choice.usedBy !== null"
              >
                {{ choice.pin }}
                @if (choice.usedBy) {
                  (used by {{ choice.usedBy }})
                }
              </mat-option>
            }
          </mat-select>
          <mat-error>Choose the pin the relay is wired to.</mat-error>
        </mat-form-field>

        <mat-form-field>
          <mat-label>On level</mat-label>
          <mat-select formControlName="onLevel">
            @for (choice of onLevelChoices; track choice.level) {
              <mat-option [value]="choice.level">{{ choice.label }}</mat-option>
            }
          </mat-select>
          <mat-error>Choose the level that energises the relay.</mat-error>
        </mat-form-field>

        @if (isMappingLocked) {
          <p class="temp-locked">
            {{ editedDevice?.name }} is on. Turn it off before changing its pin
            or on level.
          </p>
        } @else if (!editedDevice) {
          <p class="temp-warning">
            The pin and on level decide which relay this device drives and what
            "on" means. Check them against the wiring: the wrong on level runs
            the relay whenever tempestas means off.
          </p>
        }
        @for (warning of remappingWarnings(); track warning) {
          <p class="temp-warning" role="alert">{{ warning }}</p>
        }

        <mat-form-field>
          <mat-label>On delay (seconds)</mat-label>
          <input
            matInput
            type="number"
            inputmode="numeric"
            formControlName="onDelayDuration"
            [min]="minOnDelaySeconds"
          />
          <mat-hint
            >The shortest time it stays off before turning on again.</mat-hint
          >
          <mat-error>A whole number of seconds, 0 or more.</mat-error>
        </mat-form-field>

        <mat-form-field>
          <mat-label>Input rating (BTU/hr)</mat-label>
          <input
            matInput
            type="number"
            inputmode="numeric"
            formControlName="inputBtuPerHour"
            [min]="minInputBtuPerHour"
            [max]="maxInputBtuPerHour"
          />
          <mat-hint>Leave blank if it burns no propane.</mat-hint>
          <mat-error
            >A whole number from {{ minInputBtuPerHour }} to
            {{ maxInputBtuPerHour }}.</mat-error
          >
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancel</button>
        <button mat-flat-button type="submit" [disabled]="isSaving()">
          {{ editedDevice ? 'Save' : 'Add device' }}
        </button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    mat-dialog-content {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    mat-form-field {
      width: 100%;
    }
    .temp-muted {
      opacity: 0.7;
    }
    .temp-fixed {
      margin: 0 0 1rem;
    }
    .temp-warning,
    .temp-locked {
      margin: 0 0 1rem;
      padding: 0.5rem 0.75rem;
      border-left: 4px solid var(--temp-gauge-orange);
    }
    .temp-locked {
      border-left-color: var(--temp-gauge-red);
    }
  `,
})
export class DeviceFormDialog {
  private readonly api = inject(ApiService);
  private readonly dialogRef = inject(MatDialogRef<DeviceFormDialog, Device>);
  private readonly data = inject<DeviceFormDialogData>(MAT_DIALOG_DATA);

  protected readonly editedDevice = this.data.device;
  protected readonly title = this.editedDevice
    ? `Edit ${this.editedDevice.name}`
    : 'Add device';
  protected readonly isMappingLocked = this.editedDevice?.isOn ?? false;
  protected readonly roles = Object.values(DeviceRole);
  protected readonly labelRole = labelRole;
  protected readonly onLevelChoices = ON_LEVEL_CHOICES;
  protected readonly minOnDelaySeconds = MIN_ON_DELAY_SECONDS;
  protected readonly minInputBtuPerHour = MIN_INPUT_BTU_PER_HOUR;
  protected readonly maxInputBtuPerHour = MAX_INPUT_BTU_PER_HOUR;
  protected readonly isSaving = signal(false);

  protected readonly form = this.buildForm(
    this.editedDevice ? readDeviceForm(this.editedDevice) : emptyDeviceForm(),
  );

  private readonly formValue = toSignal(
    this.form.valueChanges.pipe(map(() => this.form.getRawValue())),
    { initialValue: this.form.getRawValue() },
  );
  private readonly nodes = toSignal(
    this.api.nodes().pipe(catchError(() => of<Node[]>([]))),
    { initialValue: [] },
  );
  protected readonly zones = toSignal(
    this.api.fetchZones().pipe(catchError(() => of<Zone[]>([]))),
    { initialValue: [] },
  );

  protected readonly nodesWithPins = computed(() =>
    this.nodes().filter(exposesPins),
  );
  protected readonly pinChoices = computed(() =>
    listPinChoices(
      this.findChosenNode(this.formValue().nodeId),
      this.data.devices,
      this.editedDevice,
    ),
  );
  protected readonly remappingWarnings = computed(() =>
    this.editedDevice
      ? describeRemapping(this.editedDevice, this.formValue())
      : [],
  );

  constructor() {
    this.clearPinWhenNodeChanges();
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue() as CompleteDeviceFormValue;
    const request = this.editedDevice
      ? this.api.updateDevice(this.editedDevice.id, buildUpdatePayload(value))
      : this.api.createDevice(buildCreatePayload(value));

    this.isSaving.set(true);
    request.subscribe({
      next: (saved) => this.dialogRef.close(saved),
      error: () => this.isSaving.set(false),
    });
  }

  private buildForm(initial: DeviceFormValue) {
    const form = new FormGroup({
      name: new FormControl(initial.name, {
        nonNullable: true,
        validators: [requireNonBlank],
      }),
      nodeId: new FormControl<NodeId | null>(initial.nodeId, [
        Validators.required,
      ]),
      zoneId: new FormControl<string | null>(initial.zoneId),
      role: new FormControl<DeviceRole | null>(initial.role),
      gpio: new FormControl<number | null>(initial.gpio, [Validators.required]),
      onLevel: new FormControl<GpioLevel | null>(initial.onLevel, [
        Validators.required,
      ]),
      onDelayDuration: new FormControl<number | null>(initial.onDelayDuration, [
        Validators.required,
        Validators.min(MIN_ON_DELAY_SECONDS),
        requireWholeNumber,
      ]),
      inputBtuPerHour: new FormControl<number | null>(initial.inputBtuPerHour, [
        Validators.min(MIN_INPUT_BTU_PER_HOUR),
        Validators.max(MAX_INPUT_BTU_PER_HOUR),
        requireWholeNumber,
      ]),
    });
    if (this.isMappingLocked) {
      form.controls.gpio.disable();
      form.controls.onLevel.disable();
    }
    return form;
  }

  private findChosenNode(slug: NodeId | null): Node | undefined {
    return this.nodes().find((node) => node.slug === slug);
  }

  private clearPinWhenNodeChanges(): void {
    if (this.editedDevice) return;
    this.form.controls.nodeId.valueChanges.subscribe(() =>
      this.form.controls.gpio.setValue(null),
    );
  }
}
