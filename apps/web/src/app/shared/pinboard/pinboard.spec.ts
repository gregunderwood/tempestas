import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import {
  ArrangeMode,
  injectCardArrangement,
} from '../arrange/card-arrangement';
import type { CardOrder, OrderStorage } from '../arrange/card-order';
import { Pinboard } from './pinboard';

const STORAGE_KEY = 'tempestas.card-order.test';
const TWO_COLUMN_AREA_WIDTH = 700;
const PIN_HEIGHT = 100;

interface Zone {
  id: string;
  name: string;
}

const DEFAULT_ZONES: Zone[] = [
  { id: 'crawlspace', name: 'Crawlspace' },
  { id: 'greenhouse', name: 'Greenhouse' },
  { id: 'pumphouse', name: 'Pumphouse' },
];

let sharedStorage: OrderStorage;

@Component({
  selector: 'temp-arranged-board',
  imports: [Pinboard],
  template: `
    <temp-pinboard
      [items]="zones()"
      [identify]="identifyZone"
      [nameOf]="nameZone"
      [columnMinimumRem]="20"
      [isArranging]="arrangement.isArranging()"
      (reordered)="arrangement.save($event)"
    >
      <ng-template let-zone>
        <p class="zone">{{ zone.name }}</p>
      </ng-template>
    </temp-pinboard>
  `,
})
class ArrangedBoard {
  readonly arrangement = injectCardArrangement(STORAGE_KEY, sharedStorage);
  readonly defaultZones = signal(DEFAULT_ZONES);
  readonly zones = computed(() =>
    this.arrangement.arrange(this.defaultZones(), this.identifyZone),
  );
  readonly identifyZone = (zone: Zone): string => zone.id;
  readonly nameZone = (zone: Zone): string => zone.name;
}

function memoryStorage(): OrderStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

interface RenderedBoard {
  fixture: ComponentFixture<ArrangedBoard>;
  element: HTMLElement;
  arrangeMode: ArrangeMode;
}

function renderBoard(): RenderedBoard {
  TestBed.configureTestingModule({
    imports: [ArrangedBoard],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(ArrangedBoard);
  fixture.detectChanges();
  return {
    fixture,
    element: fixture.nativeElement as HTMLElement,
    arrangeMode: TestBed.inject(ArrangeMode),
  };
}

function zoneNames(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('.zone')).map(
    (zone) => zone.textContent?.trim() ?? '',
  );
}

function moveButton(
  element: HTMLElement,
  label: string,
): HTMLButtonElement | null {
  return element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

async function startArranging(board: RenderedBoard): Promise<void> {
  board.arrangeMode.toggleArranging();
  board.fixture.detectChanges();
  await board.fixture.whenStable();
}

async function click(
  board: RenderedBoard,
  button: HTMLButtonElement | null,
): Promise<void> {
  button?.click();
  board.fixture.detectChanges();
  await board.fixture.whenStable();
}

describe('Pinboard arranging', () => {
  beforeEach(() => {
    sharedStorage = memoryStorage();
  });

  it('shows no handle or move buttons until Arrange is on', async () => {
    const board = renderBoard();
    expect(board.element.querySelector('.pinboard__arrange')).toBeNull();
    expect(board.element.textContent).not.toContain('Arranging cards');

    await startArranging(board);

    expect(board.element.querySelectorAll('.pinboard__arrange')).toHaveLength(
      3,
    );
    expect(board.element.querySelectorAll('.pinboard__handle')).toHaveLength(3);
    expect(board.element.textContent).toContain('Arranging cards');
  });

  it('cannot move the first card earlier or the last card later', async () => {
    const board = renderBoard();
    await startArranging(board);
    expect(
      moveButton(board.element, 'Move earlier: Crawlspace')?.disabled,
    ).toBe(true);
    expect(moveButton(board.element, 'Move later: Pumphouse')?.disabled).toBe(
      true,
    );
    expect(moveButton(board.element, 'Move later: Crawlspace')?.disabled).toBe(
      false,
    );
  });

  it('reorders from the keyboard and keeps focus on the moved card', async () => {
    const board = renderBoard();
    await startArranging(board);

    await click(board, moveButton(board.element, 'Move earlier: Pumphouse'));
    await click(board, moveButton(board.element, 'Move earlier: Pumphouse'));

    expect(zoneNames(board.element)).toEqual([
      'Pumphouse',
      'Crawlspace',
      'Greenhouse',
    ]);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Move later: Pumphouse',
    );
  });

  it('keeps the order for the next visit, and Reset order restores the default', async () => {
    const firstVisit = renderBoard();
    await startArranging(firstVisit);
    await click(
      firstVisit,
      moveButton(firstVisit.element, 'Move later: Crawlspace'),
    );
    firstVisit.fixture.destroy();
    TestBed.resetTestingModule();

    const secondVisit = renderBoard();
    expect(zoneNames(secondVisit.element)).toEqual([
      'Greenhouse',
      'Crawlspace',
      'Pumphouse',
    ]);

    secondVisit.arrangeMode.resetOrder();
    secondVisit.fixture.detectChanges();
    expect(zoneNames(secondVisit.element)).toEqual([
      'Crawlspace',
      'Greenhouse',
      'Pumphouse',
    ]);
    expect(sharedStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('puts a card added since the order was saved at the end', async () => {
    const board = renderBoard();
    await startArranging(board);
    await click(board, moveButton(board.element, 'Move earlier: Pumphouse'));

    board.fixture.componentInstance.defaultZones.set([
      { id: 'attic', name: 'Attic' },
      ...DEFAULT_ZONES,
    ]);
    board.fixture.detectChanges();

    expect(zoneNames(board.element)).toEqual([
      'Crawlspace',
      'Pumphouse',
      'Greenhouse',
      'Attic',
    ]);
  });

  it('stops arranging when the page that offered it goes away', async () => {
    const board = renderBoard();
    await startArranging(board);
    expect(board.arrangeMode.isOffered()).toBe(true);

    board.fixture.destroy();

    expect(board.arrangeMode.isOffered()).toBe(false);
    expect(board.arrangeMode.isArranging()).toBe(false);
  });
});

type PinDrop = CdkDragDrop<number, number, string>;

class ControlledResizeObserver {
  static latest: ControlledResizeObserver | null = null;
  private readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.latest = this;
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  resize(sizes: ReadonlyMap<Element, { width: number; height: number }>): void {
    const entries = Array.from(sizes, ([target, size]) => ({
      target,
      contentRect: size,
    })) as unknown as ResizeObserverEntry[];
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

async function renderTwoColumnBoard(): Promise<RenderedBoard> {
  const board = renderBoard();
  await startArranging(board);
  const area = board.element.querySelector('.pinboard');
  if (area !== null) {
    ControlledResizeObserver.latest?.resize(
      new Map([[area, { width: TWO_COLUMN_AREA_WIDTH, height: 0 }]]),
    );
  }
  board.fixture.detectChanges();
  await board.fixture.whenStable();
  return board;
}

function readColumns(element: HTMLElement): string[][] {
  return Array.from(element.querySelectorAll('.pinboard__column')).map(
    (column) =>
      Array.from(column.querySelectorAll('.pinboard__pin')).map(
        (pin) => pin.getAttribute('data-pin-key') ?? '',
      ),
  );
}

function collectReorders(board: RenderedBoard): CardOrder[] {
  const reorders: CardOrder[] = [];
  const pinboard = board.fixture.debugElement.query(By.directive(Pinboard))
    .componentInstance as Pinboard<Zone>;
  pinboard.reordered.subscribe((order) => reorders.push(order));
  return reorders;
}

function dropOnto(
  board: RenderedBoard,
  movedKey: string,
  from: { column: number; index: number },
  to: { column: number; index: number },
): void {
  const dropLists = board.fixture.debugElement
    .queryAll(By.directive(CdkDropList))
    .map((column) => column.injector.get(CdkDropList));
  const landingList = dropLists[to.column];
  const drop = {
    item: { data: movedKey },
    previousContainer: dropLists[from.column],
    container: landingList,
    previousIndex: from.index,
    currentIndex: to.index,
    isPointerOverContainer: true,
  } as unknown as PinDrop;
  landingList.dropped.emit(drop);
}

describe('Pinboard dropping a dragged card', () => {
  beforeEach(() => {
    sharedStorage = memoryStorage();
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: PIN_HEIGHT,
    } as DOMRect);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ControlledResizeObserver.latest = null;
  });

  it('lays the three zones out in two columns', async () => {
    const board = await renderTwoColumnBoard();
    expect(readColumns(board.element)).toEqual([
      ['crawlspace', 'pumphouse'],
      ['greenhouse'],
    ]);
  });

  it('moves a card up within its own column', async () => {
    const board = await renderTwoColumnBoard();
    const reorders = collectReorders(board);

    dropOnto(
      board,
      'pumphouse',
      { column: 0, index: 1 },
      { column: 0, index: 0 },
    );

    expect(reorders).toEqual([['pumphouse', 'crawlspace', 'greenhouse']]);
  });

  it('moves a card into another column below the card already there', async () => {
    const board = await renderTwoColumnBoard();
    const reorders = collectReorders(board);

    dropOnto(
      board,
      'crawlspace',
      { column: 0, index: 0 },
      { column: 1, index: 1 },
    );

    expect(reorders).toEqual([['greenhouse', 'crawlspace', 'pumphouse']]);
  });

  it('emits nothing when a card is dropped where it started', async () => {
    const board = await renderTwoColumnBoard();
    const reorders = collectReorders(board);

    dropOnto(
      board,
      'greenhouse',
      { column: 1, index: 0 },
      { column: 1, index: 0 },
    );

    expect(reorders).toEqual([]);
  });
});
