import {
  convertPropaneLitres,
  DEFAULT_PROPANE_UNIT,
  formatPropane,
  PROPANE_POUNDS_PER_LITRE,
  PROPANE_UNIT_KEY,
  readSavedPropaneUnit,
  writeSavedPropaneUnit,
  type PropaneUnitStorage,
} from './propane-units';

function memoryStorage(
  entries: Record<string, string> = {},
): PropaneUnitStorage & { entries: Record<string, string> } {
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value;
    },
  };
}

function blockedStorage(): PropaneUnitStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

describe('converting propane', () => {
  it('keeps litres as they are', () => {
    expect(convertPropaneLitres(10, 'litres')).toBe(10);
  });

  it('weighs a litre at about 1.12 lb, from propane at about 0.51 kg/L', () => {
    expect(PROPANE_POUNDS_PER_LITRE).toBeCloseTo(1.124, 3);
    expect(convertPropaneLitres(10, 'pounds')).toBeCloseTo(11.24, 2);
  });
});

describe('formatPropane', () => {
  it('rounds to a tenth, in the chosen unit', () => {
    expect(formatPropane(1.6667, 'litres')).toBe('1.7 L');
    expect(formatPropane(1.6667, 'pounds')).toBe('1.9 lb');
  });

  it('shows a dash when there is no estimate', () => {
    expect(formatPropane(null, 'litres')).toBe('—');
  });
});

describe('the remembered propane unit', () => {
  it('starts on litres', () => {
    expect(DEFAULT_PROPANE_UNIT).toBe('litres');
    expect(readSavedPropaneUnit(memoryStorage())).toBe('litres');
  });

  it('reads back the choice it saved', () => {
    const storage = memoryStorage();
    writeSavedPropaneUnit(storage, 'pounds');
    expect(storage.entries[PROPANE_UNIT_KEY]).toBe('pounds');
    expect(readSavedPropaneUnit(storage)).toBe('pounds');
  });

  it('ignores a stored value that is not a unit', () => {
    expect(
      readSavedPropaneUnit(memoryStorage({ [PROPANE_UNIT_KEY]: 'gallons' })),
    ).toBe('litres');
  });

  it('falls back to litres when there is no storage', () => {
    expect(readSavedPropaneUnit(null)).toBe('litres');
    expect(() => writeSavedPropaneUnit(null, 'pounds')).not.toThrow();
  });

  it('survives a storage that refuses to be read or written', () => {
    expect(readSavedPropaneUnit(blockedStorage())).toBe('litres');
    expect(() =>
      writeSavedPropaneUnit(blockedStorage(), 'pounds'),
    ).not.toThrow();
  });
});
