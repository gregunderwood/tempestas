import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { RealtimeService } from './core/realtime.service';

@Component({
  selector: 'temp-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);

  /**
   * The nav collapses behind a button on narrow screens. Open state is tracked
   * here rather than by CSS alone so the links can be removed from the tab
   * order and hidden from a screen reader while the menu is shut.
   */
  readonly menuOpen = signal(false);

  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  readonly connected = this.realtime.connected;
  readonly status = this.realtime.status;

  /**
   * The stale-sensor banner.
   *
   * Layer 1 of the safety design holds last state when readings stop rather than
   * failing everything off or forcing heat on, and it says out loud that this is
   * "only sound if the alarm is actually visible". This is that alarm. It is a
   * required part of the feature, not a nice-to-have, which is why it lives in
   * the shell and not on a screen somebody might not be looking at.
   */
  readonly sensorStale = computed(() => this.status()?.sensorStale === true);

  readonly staleRoles = computed(
    () => this.status()?.staleRoles.join(', ') ?? '',
  );

  constructor() {
    // A menu left open across a navigation covers the screen somebody just
    // asked to see.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.closeMenu());
  }

  ngOnInit(): void {
    this.realtime.connect();
  }
}
