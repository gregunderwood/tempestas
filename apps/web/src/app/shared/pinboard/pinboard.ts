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
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  countColumns,
  keepColumnAssignment,
  packIntoColumns,
} from './pin-columns';

const GAP_REM = 1;
const BROWSER_DEFAULT_REM_PIXELS = 16;
const UNMEASURED_HEIGHT = 1;
const PIN_KEY_ATTRIBUTE = 'data-pin-key';

interface Packing {
  columnCount: number;
  isSettled: boolean;
  columnKeys: string[][];
}

// Measured heights stay true wherever a card moves, because every column has the same width.
@Component({
  selector: 'temp-pinboard',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pinboard" #area>
      @for (column of columns(); track $index) {
        <div
          class="pinboard__column"
          [style.max-width.rem]="columnMaximumRem()"
        >
          @for (item of column; track identify()(item)) {
            <div
              #pin
              class="pinboard__pin"
              [attr.data-pin-key]="identify()(item)"
            >
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
  `,
})
export class Pinboard<Item> {
  readonly items = input.required<readonly Item[]>();
  readonly identify = input.required<(item: Item) => string>();
  readonly columnMinimumRem = input.required<number>();
  readonly columnMaximumRem = input<number | null>(null);

  protected readonly pinTemplate = contentChild.required(TemplateRef);
  private readonly area = viewChild.required<ElementRef<HTMLElement>>('area');
  private readonly pins = viewChildren<ElementRef<HTMLElement>>('pin');

  private readonly areaWidth = signal(0);
  private readonly pinHeights = signal<ReadonlyMap<string, number>>(new Map());
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
    const previous = this.previousPacking;
    const isSameColumnCount = previous?.columnCount === columnCount;
    const canKeepColumns = isSameColumnCount && previous.isSettled;
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
      columnKeys: columns.map((column) => column.map(identify)),
    };
    return columns;
  });

  constructor() {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => this.recordSizes(entries));
    inject(DestroyRef).onDestroy(() => observer.disconnect());
    effect(() => observer.observe(this.area().nativeElement));
    const injector = inject(Injector);
    effect(() => {
      this.columnCount();
      afterNextRender({ read: () => this.measureEveryPin() }, { injector });
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
