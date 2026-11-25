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
import { NodeUpdateCard, type UpdateConfirmation } from './node-update-card';

function node(
  overrides: Partial<Node> = {},
  updateSummary: Partial<NodeUpdateSummary> = {},
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
    updateSummary: { ...NO_UPDATE_SUMMARY, ...updateSummary },
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
  const confirmed: UpdateConfirmation[] = [];
  fixture.componentInstance.confirmed.subscribe((confirmation) =>
    confirmed.push(confirmation),
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
    show(next: Node) {
      fixture.componentRef.setInput('node', next);
      fixture.detectChanges();
    },
    showSending(isSending: boolean) {
      fixture.componentRef.setInput('isSending', isSending);
      fixture.detectChanges();
    },
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
    expect(confirmed).toEqual([{ action: 'update', version: '1.1.1' }]);
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

    expect(confirmed).toEqual([{ action: 'roll-back', version: '1.1.0' }]);
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

  it('drops an open confirmation once the offer changes, so a stale version is never sent', () => {
    const { card, findButton, render, show } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();
    show(node({ availableUpdate: '1.1.2' }));

    expect(card.textContent).not.toContain('fail-safe levels');
    expect(findButton('Update to 1.1.2')).toBeDefined();
  });

  it('drops an open confirmation when the page moves to another node', () => {
    const { card, findButton, render, show } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();
    show(node({ id: 'elantris-id', slug: 'elantris' }));

    expect(card.textContent).not.toContain('fail-safe levels');
  });

  it('drops an open confirmation when the update becomes blocked', () => {
    const { card, findButton, render, show } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();
    show(node({}, { blockedBecause: '"elantris" is updating.' }));

    expect(card.textContent).not.toContain('fail-safe levels');
    expect(findButton('Update to 1.1.1')?.disabled).toBe(true);
  });

  it('does not bring a dropped confirmation back once the block lifts', () => {
    const { card, findButton, render, show } = renderCard(node());

    findButton('Update to 1.1.1')?.click();
    render();
    show(node({}, { blockedBecause: '"elantris" is updating.' }));
    show(node());

    expect(card.textContent).not.toContain('fail-safe levels');
    expect(findButton('Update to 1.1.1')?.disabled).toBe(false);
  });

  it('offers no button while the request is on its way, so it cannot be sent twice', () => {
    const { card, findButton, showSending } = renderCard(node());

    showSending(true);

    expect(card.textContent).toContain('Sending…');
    expect(findButton('Update to 1.1.1')).toBeUndefined();

    showSending(false);

    expect(findButton('Update to 1.1.1')).toBeDefined();
  });

  it('says why a node that cannot update from here is not offered one', () => {
    const { card } = renderCard(
      node(
        { availableUpdate: null },
        { notUpdatableBecause: 'This agent needs contract 1.1.' },
      ),
    );

    expect(card.textContent).toContain('This agent needs contract 1.1.');
    expect(card.textContent).not.toContain('Up to date.');
  });
});
