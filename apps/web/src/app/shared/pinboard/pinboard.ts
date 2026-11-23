import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  TemplateRef,
  afterNextRender,
  computed,
  contentChild,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  CdkDrag,
  CdkDragHandle,
  CdkDropList,
  CdkDropListGroup,
  type CdkDragDrop,
} from '@angular/cdk/drag-drop';
import {
  applyDrop,
  moveOneStep,
  type CardOrder,
  type MoveDirection,
} from '../arrange/card-order';
import {
  countColumns,
  hasReordered,
  keepColumnAssignment,
  packIntoColumns,
} from './pin-columns';

const GAP_REM = 1;
const BROWSER_DEFAULT_REM_PIXELS = 16;
const UNMEASURED_HEIGHT = 1;
const PIN_KEY_ATTRIBUTE = 'data-pin-key';
const MOVE_DIRECTION_ATTRIBUTE = 'data-move';
const OPPOSITE_DIRECTION: Record<MoveDirection, MoveDirection> = {
  earlier: 'later',
  later: 'earlier',
};

interface Packing {
  columnCount: number;
  isSettled: boolean;
  itemKeys: string[];
  columnKeys: string[][];
}

type PinDrop = CdkDragDrop<number, number, string>;

// Measured heights stay true wherever a card moves, because every column has the same width.
@Component({
  selector: 'temp-pinboard',
  imports: [
    NgTemplateOutlet,
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="pinboard__hint" aria-live="polite">
      @if (isArranging()) {
        Arranging cards. Drag a card by its handle, or use Move earlier and Move
        later. The order is kept in this browser only.
      }
    </p>
    <div class="pinboard" #area cdkDropListGroup>
      @for (column of columns(); track $index; let columnIndex = $index) {
        <div
          class="pinboard__column"
          cdkDropList
          [cdkDropListData]="columnIndex"
          [cdkDropListDisabled]="!isArranging()"
          (cdkDropListDropped)="dropPin($event)"
          [style.max-width.rem]="columnMaximumRem()"
        >
          @for (item of column; track identify()(item)) {
            <div
              #pin
              class="pinboard__pin"
              cdkDrag
              [cdkDragData]="identify()(item)"
              [cdkDragDisabled]="!isArranging()"
              [attr.data-pin-key]="identify()(item)"
            >
              @if (isArranging()) {
                <div
                  class="pinboard__arrange"
                  role="group"
                  [attr.aria-label]="'Arrange ' + nameOf()(item)"
                >
                  <span
                    class="pinboard__handle"
                    cdkDragHandle
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path [attr.d]="gripGlyph" />
                    </svg>
                    Drag
                  </span>
                  @for (direction of moveDirections; track direction) {
                    <button
                      type="button"
                      class="pinboard__move"
                      [attr.data-move]="direction"
                      [attr.aria-label]="
                        'Move ' + direction + ': ' + nameOf()(item)
                      "
                      [disabled]="!canMove(identify()(item), direction)"
                      (click)="movePin(identify()(item), direction)"
                    >
                      Move {{ direction }}
                    </button>
                  }
                </div>
              }
              <ng-container
                *ngTemplateOutlet="pinTemplate(); context: { $implicit: item }"
              />
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .pinboard {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
    }
    .pinboard__column {
      display: flex;
      flex: 1 1 0;
      flex-direction: column;
      gap: 1rem;
      min-width: 0;
    }
    .pinboard__hint:empty {
      display: none;
    }
    .pinboard__hint {
      margin: 0 0 1rem;
      font-weight: 500;
    }
    .pinboard__arrange {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .pinboard__handle,
    .pinboard__move {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      min-height: 3rem;
      min-width: 3rem;
      padding: 0 0.85rem;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 0.75rem;
      background: var(--mat-sys-surface-container);
      color: inherit;
      font: inherit;
    }
    .pinboard__handle {
      cursor: grab;
      touch-action: none;
    }
    .pinboard__handle svg {
      width: 1.25rem;
      height: 1.25rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 3;
      stroke-linecap: round;
    }
    .pinboard__move:disabled {
      opacity: 0.45;
    }
    .pinboard__move:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
    .cdk-drag-preview {
      box-shadow: var(--mat-sys-level3);
    }
    .cdk-drag-placeholder {
      opacity: 0.35;
    }
  `,
})
export class Pinboard<Item> {
  readonly items = input.required<readonly Item[]>();
  readonly identify = input.required<(item: Item) => string>();
  readonly columnMinimumRem = input.required<number>();
  readonly columnMaximumRem = input<number | null>(null);
  readonly nameOf = input.required<(item: Item) => string>();
  readonly isArranging = input(false);
  readonly reordered = output<CardOrder>();

  protected readonly moveDirections: readonly MoveDirection[] = [
    'earlier',
    'later',
  ];
  protected readonly gripGlyph =
    'M9 5h.01 M15 5h.01 M9 12h.01 M15 12h.01 M9 19h.01 M15 19h.01';

  protected readonly pinTemplate = contentChild.required(TemplateRef);
  private readonly area = viewChild.required<ElementRef<HTMLElement>>('area');
  private readonly pins = viewChildren<ElementRef<HTMLElement>>('pin');

  private readonly areaWidth = signal(0);
  private readonly pinHeights = signal<ReadonlyMap<string, number>>(new Map());
  private readonly injector = inject(Injector);
  private readonly itemKeys = computed(() => this.items().map(this.identify()));
  // Repacking on every height change would move a card while somebody is using it.
  private previousPacking: Packing | null = null;

  private readonly columnCount = computed(() => {
    const remInPixels = readRemInPixels();
    return countColumns(
      this.areaWidth(),
      this.columnMinimumRem() * remInPixels,
      GAP_REM * remInPixels,
    );
  });

  protected readonly columns = computed(() => {
    const columnCount = this.columnCount();
    const heights = this.pinHeights();
    const identify = this.identify();
    const items = this.items();
    const measureHeight = (item: Item) =>
      heights.get(identify(item)) ?? UNMEASURED_HEIGHT;
    const itemKeys = this.itemKeys();
    const previous = this.previousPacking;
    const isSameColumnCount = previous?.columnCount === columnCount;
    const canKeepColumns =
      isSameColumnCount &&
      previous.isSettled &&
      !hasReordered(previous.itemKeys, itemKeys);
    const columns = canKeepColumns
      ? keepColumnAssignment(
          previous.columnKeys,
          items,
          identify,
          measureHeight,
        )
      : packIntoColumns(items, columnCount, measureHeight);
    // Heights measured at another column width are stale, so a new column count packs again once remeasured.
    const isFullyMeasured = items.every((item) => heights.has(identify(item)));
    this.previousPacking = {
      columnCount,
      isSettled: canKeepColumns || (isSameColumnCount && isFullyMeasured),
      itemKeys,
      columnKeys: columns.map((column) => column.map(identify)),
    };
    return columns;
  });

  constructor() {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => this.recordSizes(entries));
    inject(DestroyRef).onDestroy(() => observer.disconnect());
    effect(() => observer.observe(this.area().nativeElement));
    effect(() => {
      this.columnCount();
      afterNextRender(
        { read: () => this.measureEveryPin() },
        { injector: this.injector },
      );
    });
    let observedPins = new Set<HTMLElement>();
    effect(() => {
      const currentPins = new Set(this.pins().map((pin) => pin.nativeElement));
      for (const departed of observedPins) {
        if (!currentPins.has(departed)) observer.unobserve(departed);
      }
      for (const pin of currentPins) observer.observe(pin);
      observedPins = currentPins;
    });
  }

  protected canMove(key: string, direction: MoveDirection): boolean {
    const position = this.itemKeys().indexOf(key);
    const lastPosition = this.itemKeys().length - 1;
    return direction === 'earlier' ? position > 0 : position < lastPosition;
  }

  // Moving to another column rebuilds the card, so focus follows it to the same button.
  protected movePin(key: string, direction: MoveDirection): void {
    this.reordered.emit(moveOneStep(this.itemKeys(), key, direction));
    afterNextRender(
      { write: () => this.focusMoveButton(key, direction) },
      { injector: this.injector },
    );
  }

  protected dropPin(drop: PinDrop): void {
    const isUnmoved =
      drop.previousContainer === drop.container &&
      drop.previousIndex === drop.currentIndex;
    if (isUnmoved) return;
    const movedKey = drop.item.data;
    const landingColumnKeys = this.readColumnKeys(drop.container.data).filter(
      (key) => key !== movedKey,
    );
    landingColumnKeys.splice(drop.currentIndex, 0, movedKey);
    this.reordered.emit(
      applyDrop(this.itemKeys(), movedKey, landingColumnKeys),
    );
  }

  private readColumnKeys(columnIndex: number): string[] {
    const column = this.columns()[columnIndex] ?? [];
    return column.map(this.identify());
  }

  private focusMoveButton(key: string, direction: MoveDirection): void {
    const pin = this.pins().find(
      (candidate) =>
        candidate.nativeElement.getAttribute(PIN_KEY_ATTRIBUTE) === key,
    );
    if (pin === undefined) return;
    const findButton = (wanted: MoveDirection): HTMLButtonElement | null =>
      pin.nativeElement.querySelector<HTMLButtonElement>(
        `[${MOVE_DIRECTION_ATTRIBUTE}="${wanted}"]:not(:disabled)`,
      );
    const button =
      findButton(direction) ?? findButton(OPPOSITE_DIRECTION[direction]);
    button?.focus();
  }

  private measureEveryPin(): void {
    const heights = new Map<string, number>();
    for (const pin of this.pins()) {
      const pinKey = pin.nativeElement.getAttribute(PIN_KEY_ATTRIBUTE);
      const height = pin.nativeElement.getBoundingClientRect().height;
      if (pinKey !== null) heights.set(pinKey, Math.round(height));
    }
    this.pinHeights.set(heights);
  }

  private recordSizes(entries: readonly ResizeObserverEntry[]): void {
    const changedHeights = new Map(this.pinHeights());
    let hasHeightChanged = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const pinKey = element.getAttribute(PIN_KEY_ATTRIBUTE);
      if (pinKey === null) {
        this.areaWidth.set(entry.contentRect.width);
        continue;
      }
      const height = Math.round(entry.contentRect.height);
      if (changedHeights.get(pinKey) === height) continue;
      changedHeights.set(pinKey, height);
      hasHeightChanged = true;
    }
    if (hasHeightChanged) this.pinHeights.set(changedHeights);
  }
}

function readRemInPixels(): number {
  const rootFontSize = parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return rootFontSize || BROWSER_DEFAULT_REM_PIXELS;
}
