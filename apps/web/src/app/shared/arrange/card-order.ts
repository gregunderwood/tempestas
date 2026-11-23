export type CardOrder = readonly string[];

export type MoveDirection = 'earlier' | 'later';

export type OrderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function arrangeInSavedOrder<Item>(
  items: readonly Item[],
  savedOrder: CardOrder | null,
  identify: (item: Item) => string,
): Item[] {
  if (savedOrder === null) return [...items];
  const savedPositions = new Map(
    savedOrder.map((key, position) => [key, position]),
  );
  const savedPositionOf = (item: Item): number =>
    savedPositions.get(identify(item)) ?? Number.POSITIVE_INFINITY;
  const savedItems = items
    .filter((item) => savedPositions.has(identify(item)))
    .sort((first, second) => savedPositionOf(first) - savedPositionOf(second));
  const unsavedItems = items.filter(
    (item) => !savedPositions.has(identify(item)),
  );
  return [...savedItems, ...unsavedItems];
}

export function moveOneStep(
  order: CardOrder,
  movedKey: string,
  direction: MoveDirection,
): string[] {
  const from = order.indexOf(movedKey);
  const to = direction === 'earlier' ? from - 1 : from + 1;
  const isOutOfRange = from === -1 || to < 0 || to >= order.length;
  if (isOutOfRange) return [...order];
  const withoutMoved = order.filter((key) => key !== movedKey);
  return insertAt(withoutMoved, to, movedKey);
}

// The landing column is read as it looks after the drop, so the card's new neighbours say where it goes.
export function applyDrop(
  order: CardOrder,
  movedKey: string,
  landingColumnKeys: readonly string[],
): string[] {
  const landingIndex = landingColumnKeys.indexOf(movedKey);
  if (landingIndex === -1 || !order.includes(movedKey)) return [...order];
  const withoutMoved = order.filter((key) => key !== movedKey);
  const nextKey = landingColumnKeys[landingIndex + 1];
  const previousKey = landingColumnKeys[landingIndex - 1];
  if (nextKey !== undefined) {
    return insertAt(withoutMoved, withoutMoved.indexOf(nextKey), movedKey);
  }
  if (previousKey !== undefined) {
    return insertAt(
      withoutMoved,
      withoutMoved.indexOf(previousKey) + 1,
      movedKey,
    );
  }
  return [...withoutMoved, movedKey];
}

export function openBrowserStorage(): OrderStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSavedOrder(
  storage: OrderStorage | null,
  storageKey: string,
): CardOrder | null {
  if (storage === null) return null;
  try {
    const stored = storage.getItem(storageKey);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    return isCardOrder(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A full or blocked storage costs only the arrangement, never the page.
export function writeSavedOrder(
  storage: OrderStorage | null,
  storageKey: string,
  order: CardOrder,
): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(order));
  } catch {
    return;
  }
}

export function forgetSavedOrder(
  storage: OrderStorage | null,
  storageKey: string,
): void {
  try {
    storage?.removeItem(storageKey);
  } catch {
    return;
  }
}

function isCardOrder(candidate: unknown): candidate is CardOrder {
  return (
    Array.isArray(candidate) &&
    candidate.every((entry) => typeof entry === 'string')
  );
}

function insertAt(
  keys: readonly string[],
  index: number,
  insertedKey: string,
): string[] {
  return [...keys.slice(0, index), insertedKey, ...keys.slice(index)];
}
