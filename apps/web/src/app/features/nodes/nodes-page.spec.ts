import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { NodeStatus, type Node } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  fakeRealtime,
  pushNode,
  type FakeRealtime,
} from '../../testing/fake-realtime';
import { NodesPage } from './nodes-page';

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'patji-id',
    slug: 'patji',
    displayName: 'Pumphouse',
    kind: 'rpi',
    status: NodeStatus.Admitted,
    online: true,
    deviceCount: 2,
    agentName: 'agent-linux',
    agentVersion: '1.2.0',
    contractStanding: 'current',
    ...overrides,
  } as unknown as Node;
}

interface RenderedPage {
  page: HTMLElement;
  realtime: FakeRealtime;
  render(): void;
}

function renderNodesPage(fetchedNodes: Node[] = [node()]): RenderedPage {
  const realtime = fakeRealtime();
  TestBed.configureTestingModule({
    imports: [NodesPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: { nodes: () => of(fetchedNodes) } },
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const fixture = TestBed.createComponent(NodesPage);
  fixture.detectChanges();
  return {
    page: fixture.nativeElement as HTMLElement,
    realtime,
    render: () => fixture.detectChanges(),
  };
}

function cardTexts(page: HTMLElement): string[] {
  return [...page.querySelectorAll('mat-card')].map(
    (card) => card.textContent ?? '',
  );
}

describe('NodesPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a node going offline and coming back without a reload', () => {
    const { page, realtime, render } = renderNodesPage();
    vi.advanceTimersByTime(1);

    pushNode(realtime, node({ online: false }));
    render();
    expect(cardTexts(page)[0]).toContain('offline');

    vi.advanceTimersByTime(1);
    pushNode(realtime, node({ online: true }));
    render();
    expect(cardTexts(page)[0]).not.toContain('offline');
  });

  it('shows a node that announces itself as pending, with its admit button', () => {
    const { page, realtime, render } = renderNodesPage();
    vi.advanceTimersByTime(1);

    pushNode(
      realtime,
      node({
        id: 'braize-id',
        slug: 'braize',
        displayName: 'braize',
        status: NodeStatus.Pending,
      }),
    );
    render();

    const [braize] = cardTexts(page);
    expect(braize).toContain('pending');
    expect(braize).toContain('Admit');
  });

  it('shows an agent upgrade', () => {
    const { page, realtime, render } = renderNodesPage();
    vi.advanceTimersByTime(1);

    pushNode(realtime, node({ agentVersion: '1.3.0' }));
    render();

    expect(cardTexts(page)[0]).toContain('agent-linux 1.3.0');
  });

  it('says which release a node could be updated to', () => {
    const { page } = renderNodesPage([
      node({ agentVersion: '1.1.3', availableUpdate: '1.1.4' }),
    ]);
    vi.advanceTimersByTime(1);

    expect(page.querySelector('.temp-update-available')?.textContent).toBe(
      '1.1.4 available',
    );
  });

  it('says nothing when there is no newer release', () => {
    const { page } = renderNodesPage([node({ availableUpdate: null })]);
    vi.advanceTimersByTime(1);

    expect(page.querySelector('.temp-update-available')).toBeNull();
  });
});
