import type { AbstractControl, ValidationErrors } from '@angular/forms';

export function requireWholeNumber(
  control: AbstractControl,
): ValidationErrors | null {
  const value = control.value as number | null;
  if (value === null || Number.isInteger(value)) return null;
  return { wholeNumber: true };
}

export function requireNonBlank(
  control: AbstractControl,
): ValidationErrors | null {
  const text = String(control.value ?? '');
  return text.trim() === '' ? { required: true } : null;
}
