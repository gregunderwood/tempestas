import {
  DestroyRef,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { RealtimeService } from './realtime.service';

export function injectServerNow(tickMilliseconds: number): Signal<number> {
  const realtime = inject(RealtimeService);
  const browserNow = signal(Date.now());
  const ticker = setInterval(
    () => browserNow.set(Date.now()),
    tickMilliseconds,
  );
  inject(DestroyRef).onDestroy(() => clearInterval(ticker));
  return computed(
    () => browserNow() + realtime.serverClockOffsetMilliseconds(),
  );
}
