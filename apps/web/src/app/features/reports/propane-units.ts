export type PropaneUnit = 'litres' | 'pounds';

export type PropaneUnitStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const PROPANE_UNITS: readonly PropaneUnit[] = ['litres', 'pounds'];

// Superior Propane bills by the litre.
export const DEFAULT_PROPANE_UNIT: PropaneUnit = 'litres';

export const PROPANE_UNIT_KEY = 'tempestas.propane-unit.reports';

// NIST Chemistry WebBook gives liquid propane at 15 °C about 507 kg/m³, so about 0.51 kg per litre.
const PROPANE_KILOGRAMS_PER_LITRE = 0.51;
const POUNDS_PER_KILOGRAM = 2.20462;
export const PROPANE_POUNDS_PER_LITRE =
  PROPANE_KILOGRAMS_PER_LITRE * POUNDS_PER_KILOGRAM;

const PROPANE_DECIMALS = 1;
const ABSENT_FIGURE = '—';

const PROPANE_UNIT_SYMBOLS: Record<PropaneUnit, string> = {
  litres: 'L',
  pounds: 'lb',
};

const PROPANE_UNIT_LABELS: Record<PropaneUnit, string> = {
  litres: 'Litres',
  pounds: 'Pounds',
};

export function convertPropaneLitres(
  litres: number,
  unit: PropaneUnit,
): number {
  return unit === 'pounds' ? litres * PROPANE_POUNDS_PER_LITRE : litres;
}

export function formatPropane(
  litres: number | null,
  unit: PropaneUnit,
): string {
  if (litres === null) return ABSENT_FIGURE;
  const converted = convertPropaneLitres(litres, unit);
  return `${converted.toFixed(PROPANE_DECIMALS)} ${PROPANE_UNIT_SYMBOLS[unit]}`;
}

export function labelPropaneUnit(unit: PropaneUnit): string {
  return PROPANE_UNIT_LABELS[unit];
}

export function readSavedPropaneUnit(
  storage: PropaneUnitStorage | null,
): PropaneUnit {
  try {
    const stored = storage?.getItem(PROPANE_UNIT_KEY) ?? null;
    return isPropaneUnit(stored) ? stored : DEFAULT_PROPANE_UNIT;
  } catch {
    return DEFAULT_PROPANE_UNIT;
  }
}

// A full or blocked storage costs only the remembered choice, never the page.
export function writeSavedPropaneUnit(
  storage: PropaneUnitStorage | null,
  unit: PropaneUnit,
): void {
  try {
    storage?.setItem(PROPANE_UNIT_KEY, unit);
  } catch {
    return;
  }
}

function isPropaneUnit(candidate: string | null): candidate is PropaneUnit {
  return PROPANE_UNITS.some((unit) => unit === candidate);
}
