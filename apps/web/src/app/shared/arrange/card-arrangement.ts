import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  arrangeInSavedOrder,
  forgetSavedOrder,
  keepHiddenCardsInPlace,
  openBrowserStorage,
  readSavedOrder,
  writeSavedOrder,
  type CardOrder,
  type OrderStorage,
} from './card-order';

export class CardArrangement {
  private readonly savedOrder: WritableSignal<CardOrder | null>;

  constructor(
    private readonly storage: OrderStorage | null,
    private readonly storageKey: string,
    readonly isArranging: Signal<boolean>,
  ) {
    this.savedOrder = signal(readSavedOrder(storage, storageKey));
  }

  arrange<Item>(
    items: readonly Item[],
    identify: (item: Item) => string,
  ): Item[] {
    return arrangeInSavedOrder(items, this.savedOrder(), identify);
  }

  save(visibleOrder: CardOrder): void {
    const order = keepHiddenCardsInPlace(this.savedOrder(), visibleOrder);
    this.savedOrder.set(order);
    writeSavedOrder(this.storage, this.storageKey, order);
  }

  reset(): void {
    this.savedOrder.set(null);
    forgetSavedOrder(this.storage, this.storageKey);
  }
}

@Injectable({ providedIn: 'root' })
export class ArrangeMode {
  private readonly offered = signal<CardArrangement | null>(null);
  private readonly arranging = signal(false);

  readonly isOffered = computed(() => this.offered() !== null);
  readonly isArranging = this.arranging.asReadonly();

  offer(arrangement: CardArrangement): void {
    this.offered.set(arrangement);
    this.arranging.set(false);
  }

  withdraw(arrangement: CardArrangement): void {
    if (this.offered() !== arrangement) return;
    this.offered.set(null);
    this.arranging.set(false);
  }

  toggleArranging(): void {
    this.arranging.update((isArranging) => !isArranging);
  }

  resetOrder(): void {
    this.offered()?.reset();
  }
}

export function injectCardArrangement(
  storageKey: string,
  storage: OrderStorage | null = openBrowserStorage(),
): CardArrangement {
  const arrangeMode = inject(ArrangeMode);
  const arrangement = new CardArrangement(
    storage,
    storageKey,
    arrangeMode.isArranging,
  );
  arrangeMode.offer(arrangement);
  inject(DestroyRef).onDestroy(() => arrangeMode.withdraw(arrangement));
  return arrangement;
}
