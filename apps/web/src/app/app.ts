import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { RealtimeService } from './core/realtime.service';
import { PageHeading } from './core/page-heading';
import { ActivityLog } from './features/dashboard/activity-log';

interface NavLink {
  path: string;
  label: string;
  glyph: string;
}

const NAV_LINKS: readonly NavLink[] = [
  {
    path: '/dashboard',
    label: 'Dashboard',
    glyph: 'M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z',
  },
  { path: '/readings', label: 'Readings', glyph: 'M3 20h18 M5 16l4-5 4 3 6-8' },
  { path: '/zones', label: 'Zones', glyph: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5' },
  {
    path: '/devices',
    label: 'Devices',
    glyph: 'M12 3v8 M7.05 6.05a7 7 0 1 0 9.9 0',
  },
  {
    path: '/nodes',
    label: 'Nodes',
    glyph:
      'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  },
];

@Component({
  selector: 'temp-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closeMenuFromKeyboard()' },
})
export class App implements OnInit {
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  private readonly pageHeading = inject(PageHeading);

  readonly navLinks = NAV_LINKS;
  readonly heading = this.pageHeading.text;

  // A signal rather than CSS alone, so a closed menu's links leave the tab order.
  readonly menuOpen = signal(false);
  private readonly menuButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('menuButton');

  readonly connected = this.realtime.connected;
  readonly status = this.realtime.status;

  readonly sensorStale = computed(() => this.status()?.sensorStale === true);
  readonly staleRoles = computed(
    () => this.status()?.staleRoles.join(', ') ?? '',
  );

  constructor() {
    // Created here rather than by the dashboard, so it records from the moment the app opens.
    inject(ActivityLog);
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.closeMenu();
        const route = this.readDeepestRoute();
        this.pageHeading.showRoute(route.data, route.routeConfig);
      });
  }

  ngOnInit(): void {
    this.realtime.connect();
  }

  toggleMenu(): void {
    this.menuOpen.update((isOpen) => !isOpen);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  // The closed menu's links are hidden, so focus goes back to the button that opened it.
  closeMenuFromKeyboard(): void {
    if (!this.menuOpen()) return;
    this.closeMenu();
    this.menuButton().nativeElement.focus();
  }

  private readDeepestRoute(): ActivatedRouteSnapshot {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) {
      route = route.firstChild;
    }
    return route;
  }
}
