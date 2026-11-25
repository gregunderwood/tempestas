import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of, throwError, type Observable } from 'rxjs';
import type { Device } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { PUMPHOUSE, device, node } from '../zones/zone-fixtures';
import { DeviceFormDialog } from './device-form-dialog';

interface RenderedDialog {
  fixture: ComponentFixture<DeviceFormDialog>;
  form: HTMLElement;
  close: ReturnType<typeof vi.fn>;
  updateDevice: ReturnType<typeof vi.fn>;
  createDevice: ReturnType<typeof vi.fn>;
}

function renderDialog(
  edited: Device | null,
  saveAnswer: Observable<Device> = of(device()),
): RenderedDialog {
  const close = vi.fn();
  const updateDevice = vi.fn().mockReturnValue(saveAnswer);
  const createDevice = vi.fn().mockReturnValue(saveAnswer);
  TestBed.configureTestingModule({
    imports: [DeviceFormDialog],
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ApiService,
        useValue: {
          nodes: () => of([node('patji', 'z-pump')]),
          fetchZones: () => of([PUMPHOUSE]),
          updateDevice,
          createDevice,
        },
      },
      { provide: MatDialogRef, useValue: { close } },
      {
        provide: MAT_DIALOG_DATA,
        useValue: { device: edited, devices: [device()] },
      },
    ],
  });
  const fixture = TestBed.createComponent(DeviceFormDialog);
  fixture.detectChanges();
  return {
    fixture,
    form: fixture.nativeElement as HTMLElement,
    close,
    updateDevice,
    createDevice,
  };
}

function typeInto(form: HTMLElement, label: string, text: string): void {
  const input = [...form.querySelectorAll('mat-form-field')]
    .find((field) => field.textContent?.includes(label))
    ?.querySelector('input');
  if (!input) throw new Error(`No input labelled ${label}`);
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

function submit(rendered: RenderedDialog): void {
  rendered.form
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { cancelable: true }));
  rendered.fixture.detectChanges();
}

describe('DeviceFormDialog', () => {
  it('saves an edited burner rating through the device update', () => {
    const rendered = renderDialog(device());
    typeInto(rendered.form, 'Input rating', '40000');
    submit(rendered);
    expect(rendered.updateDevice).toHaveBeenCalledWith(
      'd-heater',
      expect.objectContaining({ inputBtuPerHour: 40_000 }),
    );
    expect(rendered.close).toHaveBeenCalled();
  });

  it('sends a cleared rating as none', () => {
    const rendered = renderDialog(device({ inputBtuPerHour: 40_000 }));
    typeInto(rendered.form, 'Input rating', '');
    submit(rendered);
    expect(rendered.updateDevice).toHaveBeenCalledWith(
      'd-heater',
      expect.objectContaining({ inputBtuPerHour: null }),
    );
  });

  it.each([
    ['a fraction', '40000.5'],
    ['zero', '0'],
    ['more than any greenhouse burner', '1000001'],
  ])('refuses %s of a BTU before asking the server', (_case, rating) => {
    const rendered = renderDialog(device());
    typeInto(rendered.form, 'Input rating', rating);
    submit(rendered);
    expect(rendered.updateDevice).not.toHaveBeenCalled();
    expect(rendered.form.textContent).toContain('A whole number from 1 to');
  });

  it('refuses a blank name before asking the server', () => {
    const rendered = renderDialog(device());
    typeInto(rendered.form, 'Name', '   ');
    submit(rendered);
    expect(rendered.updateDevice).not.toHaveBeenCalled();
  });

  it('will not add a device until its node, pin and on level are chosen', () => {
    const rendered = renderDialog(null);
    typeInto(rendered.form, 'Name', 'Shop heater');
    submit(rendered);
    expect(rendered.createDevice).not.toHaveBeenCalled();
    expect(rendered.form.textContent).toContain(
      'Choose the level that energises the relay.',
    );
  });

  it('stays open when the server refuses, so nothing typed is lost', () => {
    const rendered = renderDialog(
      device(),
      throwError(() => new Error('409')),
    );
    submit(rendered);
    expect(rendered.updateDevice).toHaveBeenCalled();
    expect(rendered.close).not.toHaveBeenCalled();
  });

  it('locks the pin and on level of a device that is on, and says why', () => {
    const rendered = renderDialog(device({ isOn: true }));
    const selects = [...rendered.form.querySelectorAll('mat-select')];
    const lockedSelects = selects.filter((select) =>
      select.classList.contains('mat-mdc-select-disabled'),
    );
    expect(lockedSelects).toHaveLength(2);
    expect(rendered.form.textContent).toContain(
      'Heater is on. Turn it off before changing its pin or on level.',
    );
  });

  it('says saving switches nothing', () => {
    expect(renderDialog(device()).form.textContent).toContain(
      'Saving switches nothing.',
    );
  });
});
