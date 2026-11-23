import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { Node } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { node } from '../zones/zone-fixtures';
import { NodesPage } from './nodes-page';

function renderNodesPage(listed: Node): HTMLElement {
  TestBed.configureTestingModule({
    imports: [NodesPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: { nodes: () => of([listed]) } },
    ],
  });
  const fixture = TestBed.createComponent(NodesPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('NodesPage', () => {
  it('says which release a node could be updated to', () => {
    const page = renderNodesPage({
      ...node('patji', null),
      agentName: 'agent-linux',
      agentVersion: '1.1.3',
      availableUpdate: '1.1.4',
    });

    expect(page.querySelector('.temp-update-available')?.textContent).toBe(
      '1.1.4 available',
    );
  });

  it('says nothing when there is no newer release', () => {
    const page = renderNodesPage(node('patji', null));

    expect(page.querySelector('.temp-update-available')).toBeNull();
  });
});
