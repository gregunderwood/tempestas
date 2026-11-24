import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import {
  NO_UPDATE_SUMMARY,
  NodeStatus,
  NodeUpdateOutcome,
  UpdateState,
  type Node,
  type NodeUpdate,
  type NodeUpdateSummary,
} from '@tempestas/domain';
import { NodeUpdateCard, type UpdateAction } from './node-update-card';

function node(
  overrides: Partial<Node> = {},
  updates: Partial<NodeUpdateSummary> = {},
): Node {
  return {
    id: 'patji-id',
    slug: 'patji',
    displayName: 'Pumphouse',
    status: NodeStatus.Admitted,
    online: true,
    agentName: 'agent-linux',
    agentVersion: '1.1.0',
    availableUpdate: '1.1.1',
    updates: { ...NO_UPDATE_SUMMARY, ...updates },
    ...overrides,
  } as unknown as Node;
}

function update(overrides: Partial<NodeUpdate> = {}): NodeUpdate {
  return {
    id: 'update-1',
    fromVersion: '1.1.0',
    toVersion: '1.1.1',
    isRollBack: false,
    lastState: null,
    outcome: NodeUpdateOutcome.InProgress,
    reason: null,
    startedAt: '2026-11-24T12:00:00Z',
    finishedAt: null,
    ...overrides,
  };
}

function renderCard(shown: Node) {
  TestBed.configureTestingModule({
    imports: [NodeUpdateCard],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(NodeUpdateCard);
  fixture.componentRef.setInput('node', shown);
  const confirmed: UpdateAction[] = [];
  fixture.componentInstance.confirmed.subscribe((action) =>
    confirmed.push(action),
  );
  fixture.detectChanges();
  const card = fixture.nativeElement as HTMLElement;
  return {
    card,
    confirmed,
    findButton(label: string): HTMLButtonElement | undefined {
      return [...card.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(label),
      );
    },
    render: () => fixture.detectChanges(),
  };
}

describe('NodeUpdateCard', () => {
  it('asks before updating, and says what the node will do', () => {
    const { card, confirmed, findButton, render } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();

    expect(confirmed).toEqual([]);
    expect(card.textContent).toContain('fail-safe levels');

    findButton('Update to 1.1.1')?.click();
    expect(confirmed).toEqual(['update']);
  });

  it('lets the operator back out', () => {
    const { card, confirmed, findButton, render } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();
    findButton('Cancel')?.click();
    render();

    expect(confirmed).toEqual([]);
    expect(card.textContent).not.toContain('fail-safe levels');
  });

  it('offers a roll back to the version before the last update', () => {
    const { confirmed, findButton, render } = renderCard(
      node({ availableUpdate: null }, { rollBackVersion: '1.1.0' }),
    );

    findButton('Roll back to 1.1.0')?.click();
    render();
    findButton('Roll back to 1.1.0')?.click();

    expect(confirmed).toEqual(['roll-back']);
  });

  it('disables the buttons and says why when an update cannot be sent', () => {
    const { card, findButton } = renderCard(
      node({}, { blockedBecause: '"patji" is offline.' }),
    );

    expect(findButton('Update to 1.1.1')?.disabled).toBe(true);
    expect(card.textContent).toContain('"patji" is offline.');
  });

  it('shows the state the node last reported while an update runs', () => {
    const { card, findButton } = renderCard(
      node({}, { lastUpdate: update({ lastState: UpdateState.Installing }) }),
    );

    expect(card.textContent).toContain('Update to 1.1.1');
    expect(card.textContent).toContain('installing');
    expect(card.querySelector('mat-progress-bar')).not.toBeNull();
    expect(findButton('Update to 1.1.1')).toBeUndefined();
  });

  it('keeps the last result on the page, with the reason', () => {
    const { card } = renderCard(
      node(
        { availableUpdate: null },
        {
          lastUpdate: update({
            outcome: NodeUpdateOutcome.RolledBack,
            reason: 'no heartbeat after the restart',
            finishedAt: '2026-11-24T12:02:00Z',
          }),
        },
      ),
    );

    expect(card.textContent).toContain('rolled itself back');
    expect(card.textContent).toContain('no heartbeat after the restart');
    expect(card.querySelector('.last--bad')).not.toBeNull();
  });

  it('says the node is up to date when there is nothing to do', () => {
    const { card } = renderCard(node({ availableUpdate: null }));

    expect(card.textContent).toContain('Up to date.');
  });
});
