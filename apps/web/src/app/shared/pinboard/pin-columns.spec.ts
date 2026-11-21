import {
  countColumns,
  keepColumnAssignment,
  packIntoColumns,
} from './pin-columns';

interface Pin {
  name: string;
  height: number;
}

const measureHeight = (pin: Pin) => pin.height;

function namesOf(columns: Pin[][]): string[][] {
  return columns.map((column) => column.map((pin) => pin.name));
}

describe('countColumns', () => {
  it('fits as many minimum-width columns as the area allows', () => {
    expect(countColumns(770, 352, 16)).toBe(2);
    expect(countColumns(1200, 352, 16)).toBe(3);
  });

  it('never gives fewer than one column', () => {
    expect(countColumns(0, 352, 16)).toBe(1);
  });
});

describe('packIntoColumns', () => {
  // The zones page as seen live: a short crawlspace card, a tall greenhouse card, then the pumphouse.
  it('stacks the next item under the shortest column, not the end of a row', () => {
    const columns = packIntoColumns(
      [
        { name: 'crawlspace', height: 700 },
        { name: 'greenhouse', height: 900 },
        { name: 'pumphouse', height: 700 },
      ],
      2,
      measureHeight,
    );
    expect(namesOf(columns)).toEqual([
      ['crawlspace', 'pumphouse'],
      ['greenhouse'],
    ]);
  });

  it('keeps the original order in a single column', () => {
    const columns = packIntoColumns(
      [
        { name: 'first', height: 900 },
        { name: 'second', height: 100 },
      ],
      1,
      measureHeight,
    );
    expect(namesOf(columns)).toEqual([['first', 'second']]);
  });

  // An empty column still takes its share of the width, so a lone card is never stretched across the page.
  it('keeps every column when there are fewer items than columns', () => {
    expect(
      namesOf(packIntoColumns([{ name: 'only', height: 1 }], 3, measureHeight)),
    ).toEqual([['only'], [], []]);
  });
});

describe('keepColumnAssignment', () => {
  it('keeps each item in its column, holding the latest version of it', () => {
    const columns = keepColumnAssignment(
      [['crawlspace', 'pumphouse'], ['greenhouse']],
      [
        { name: 'crawlspace', height: 900 },
        { name: 'greenhouse', height: 100 },
        { name: 'pumphouse', height: 900 },
      ],
      (pin) => pin.name,
      measureHeight,
    );
    expect(namesOf(columns)).toEqual([
      ['crawlspace', 'pumphouse'],
      ['greenhouse'],
    ]);
    expect(columns[0][0].height).toBe(900);
  });

  it('puts a new item under the shortest column without moving the others', () => {
    const columns = keepColumnAssignment(
      [['crawlspace'], ['greenhouse', 'pumphouse']],
      [
        { name: 'crawlspace', height: 900 },
        { name: 'greenhouse', height: 100 },
        { name: 'pumphouse', height: 100 },
        { name: 'workshop', height: 300 },
      ],
      (pin) => pin.name,
      measureHeight,
    );
    expect(namesOf(columns)).toEqual([
      ['crawlspace'],
      ['greenhouse', 'pumphouse', 'workshop'],
    ]);
  });

  it('leaves the gap a departed item made rather than moving the rest', () => {
    const columns = keepColumnAssignment(
      [['crawlspace', 'greenhouse'], ['pumphouse']],
      [
        { name: 'greenhouse', height: 100 },
        { name: 'pumphouse', height: 900 },
      ],
      (pin) => pin.name,
      measureHeight,
    );
    expect(namesOf(columns)).toEqual([['greenhouse'], ['pumphouse']]);
  });
});
