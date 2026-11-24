export function sortOldestFirst<Item>(
  items: readonly Item[],
  instantOf: (item: Item) => Date,
): Item[] {
  return [...items].sort(
    (first, second) => instantOf(first).getTime() - instantOf(second).getTime(),
  );
}
