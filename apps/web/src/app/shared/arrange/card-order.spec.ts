import {
  applyDrop,
  arrangeInSavedOrder,
  forgetSavedOrder,
  moveOneStep,
  readSavedOrder,
  writeSavedOrder,
  type OrderStorage,
} from './card-order';

const STORAGE_KEY = 'tempestas.card-order.test';

interface Card {
  id: string;
}

const identifyCard = (card: Card): string => card.id;

function cardsNamed(...ids: string[]): Card[] {
  return ids.map((id) => ({ id }));
}

function idsOf(cards: readonly Card[]): string[] {
  return cards.map(identifyCard);
}

function memoryStorage(initial: Record<string, string> = {}): OrderStorage {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

function refusingStorage(): OrderStorage {
  const refuse = (): never => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

describe('arrangeInSavedOrder', () => {
  it('keeps the default order when nothing is saved', () => {
    const cards = cardsNamed('crawlspace', 'greenhouse', 'pumphouse');
    expect(idsOf(arrangeInSavedOrder(cards, null, identifyCard))).toEqual([
      'crawlspace',
      'greenhouse',
      'pumphouse',
    ]);
  });

  it('puts cards in the saved order', () => {
    const cards = cardsNamed('crawlspace', 'greenhouse', 'pumphouse');
    const saved = ['greenhouse', 'pumphouse', 'crawlspace'];
    expect(idsOf(arrangeInSavedOrder(cards, saved, identifyCard))).toEqual(
      saved,
    );
  });

  it('puts a card missing from the saved order at the end, in default order', () => {
    const cards = cardsNamed('braize', 'elantris', 'patji', 'taldain');
    const saved = ['patji', 'elantris'];
    expect(idsOf(arrangeInSavedOrder(cards, saved, identifyCard))).toEqual([
      'patji',
      'elantris',
      'braize',
      'taldain',
    ]);
  });

  it('ignores saved entries for cards that no longer exist', () => {
    const cards = cardsNamed('elantris', 'patji');
    const saved = ['retired', 'patji', 'elantris'];
    expect(idsOf(arrangeInSavedOrder(cards, saved, identifyCard))).toEqual([
      'patji',
      'elantris',
    ]);
  });
});

describe('moveOneStep', () => {
  const order = ['first', 'second', 'third'];

  it('swaps a card with the one before it', () => {
    expect(moveOneStep(order, 'second', 'earlier')).toEqual([
      'second',
      'first',
      'third',
    ]);
  });

  it('swaps a card with the one after it', () => {
    expect(moveOneStep(order, 'second', 'later')).toEqual([
      'first',
      'third',
      'second',
    ]);
  });

  it('leaves the order alone at either end', () => {
    expect(moveOneStep(order, 'first', 'earlier')).toEqual(order);
    expect(moveOneStep(order, 'third', 'later')).toEqual(order);
  });

  it('leaves the order alone for an unknown card', () => {
    expect(moveOneStep(order, 'missing', 'later')).toEqual(order);
  });
});

describe('applyDrop', () => {
  // Packed into two columns: [a, c, e] and [b, d].
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('places a dropped card just before the card it landed above', () => {
    expect(applyDrop(order, 'e', ['a', 'e', 'c'])).toEqual([
      'a',
      'b',
      'e',
      'c',
      'd',
    ]);
  });

  it('places a card dropped at the top of another column before that column’s first card', () => {
    expect(applyDrop(order, 'd', ['d', 'a', 'c', 'e'])).toEqual([
      'd',
      'a',
      'b',
      'c',
      'e',
    ]);
  });

  it('places a card dropped at the foot of a column just after that column’s last card', () => {
    expect(applyDrop(order, 'a', ['b', 'd', 'a'])).toEqual([
      'b',
      'c',
      'd',
      'a',
      'e',
    ]);
  });

  it('sends a card dropped into an empty column to the end', () => {
    expect(applyDrop(order, 'b', ['b'])).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('leaves the order alone when the card is not in the landing column', () => {
    expect(applyDrop(order, 'b', ['a', 'c'])).toEqual(order);
  });
});

describe('saved order in browser storage', () => {
  it('reads back what was written', () => {
    const storage = memoryStorage();
    writeSavedOrder(storage, STORAGE_KEY, ['patji', 'elantris']);
    expect(readSavedOrder(storage, STORAGE_KEY)).toEqual(['patji', 'elantris']);
  });

  it('reads nothing once forgotten', () => {
    const storage = memoryStorage();
    writeSavedOrder(storage, STORAGE_KEY, ['patji']);
    forgetSavedOrder(storage, STORAGE_KEY);
    expect(readSavedOrder(storage, STORAGE_KEY)).toBeNull();
  });

  it('falls back to the default when storage is unavailable', () => {
    expect(readSavedOrder(null, STORAGE_KEY)).toBeNull();
    expect(() => writeSavedOrder(null, STORAGE_KEY, ['patji'])).not.toThrow();
  });

  it('falls back to the default when storage refuses access', () => {
    const storage = refusingStorage();
    expect(readSavedOrder(storage, STORAGE_KEY)).toBeNull();
    expect(() =>
      writeSavedOrder(storage, STORAGE_KEY, ['patji']),
    ).not.toThrow();
    expect(() => forgetSavedOrder(storage, STORAGE_KEY)).not.toThrow();
  });

  it.each([
    ['text that is not JSON', '{not json'],
    ['an object', '{"patji":1}'],
    ['an array holding a non-string', '["patji",7]'],
    ['null', 'null'],
  ])(
    'falls back to the default when storage holds %s',
    (_description, stored) => {
      const storage = memoryStorage({ [STORAGE_KEY]: stored });
      expect(readSavedOrder(storage, STORAGE_KEY)).toBeNull();
    },
  );
});
