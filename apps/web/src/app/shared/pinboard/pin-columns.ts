export function countColumns(
  areaWidth: number,
  columnMinimumWidth: number,
  gap: number,
): number {
  return Math.max(
    1,
    Math.floor((areaWidth + gap) / (columnMinimumWidth + gap)),
  );
}

interface FillingColumn<Item> {
  height: number;
  items: Item[];
}

export function packIntoColumns<Item>(
  items: readonly Item[],
  columnCount: number,
  measureHeight: (item: Item) => number,
): Item[][] {
  const columns = Array.from(
    { length: columnCount },
    (): FillingColumn<Item> => ({ height: 0, items: [] }),
  );
  for (const item of items) addToShortestColumn(columns, item, measureHeight);
  return columns.map((column) => column.items);
}

/** Pinned items stay in their columns with their latest version; only new items are placed. */
export function keepColumnAssignment<Item>(
  columnKeys: readonly (readonly string[])[],
  items: readonly Item[],
  identify: (item: Item) => string,
  measureHeight: (item: Item) => number,
): Item[][] {
  const itemsByKey = new Map(items.map((item) => [identify(item), item]));
  const columns = columnKeys.map((keys): FillingColumn<Item> => {
    const keptItems = keys.flatMap((key) => {
      const item = itemsByKey.get(key);
      return item === undefined ? [] : [item];
    });
    return { height: sumHeights(keptItems, measureHeight), items: keptItems };
  });
  const pinnedKeys = new Set(columnKeys.flat());
  const newItems = items.filter((item) => !pinnedKeys.has(identify(item)));
  for (const item of newItems)
    addToShortestColumn(columns, item, measureHeight);
  return columns.map((column) => column.items);
}

function addToShortestColumn<Item>(
  columns: FillingColumn<Item>[],
  item: Item,
  measureHeight: (item: Item) => number,
): void {
  const shortest = columns.reduce((shortestSoFar, candidate) =>
    candidate.height < shortestSoFar.height ? candidate : shortestSoFar,
  );
  shortest.items.push(item);
  shortest.height += measureHeight(item);
}

function sumHeights<Item>(
  items: readonly Item[],
  measureHeight: (item: Item) => number,
): number {
  return items.reduce((total, item) => total + measureHeight(item), 0);
}
