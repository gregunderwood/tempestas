import { Injectable, computed, signal } from '@angular/core';

export interface PageHeadingText {
  heading: string;
  subtitle: string;
}

const UNTITLED_PAGE: PageHeadingText = { heading: 'tempestas', subtitle: '' };

@Injectable({ providedIn: 'root' })
export class PageHeading {
  private readonly routeText = signal<PageHeadingText>(UNTITLED_PAGE);
  private readonly pageText = signal<PageHeadingText | null>(null);
  private shownRoute: object | null = null;

  readonly text = computed(() => this.pageText() ?? this.routeText());

  // A navigation that stays on the same route keeps the page's own name, since the page is still there.
  showRoute(
    routeText: Partial<PageHeadingText> | undefined,
    route: object | null,
  ): void {
    if (route !== this.shownRoute) this.pageText.set(null);
    this.shownRoute = route;
    this.routeText.set({ ...UNTITLED_PAGE, ...routeText });
  }

  showPage(pageText: PageHeadingText): void {
    this.pageText.set(pageText);
  }
}
