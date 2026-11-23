import { describe, expect, it } from 'vitest';
import type { Node } from '@tempestas/domain';
import { applyNewerNodePushes } from './live-nodes';
import { recordNodePush, type PushedNode } from './node-pushes';

const REQUESTED_AT = 1_000;
const BEFORE_REQUEST = REQUESTED_AT - 1;
const AFTER_REQUEST = REQUESTED_AT + 1;

const node = (slug: string, online: boolean): Node =>
  ({ id: `${slug}-id`, slug, online }) as Node;

function pushesOf(
  ...pushes: [Node, number][]
): ReadonlyMap<string, PushedNode> {
  return pushes.reduce(
    (recorded, [pushedNode, receivedAt]) =>
      recordNodePush(recorded, pushedNode, receivedAt),
    new Map<string, PushedNode>() as ReadonlyMap<string, PushedNode>,
  );
}

const describeNodes = (nodes: Node[]): string[] =>
  nodes.map((merged) => `${merged.slug}:${merged.online ? 'on' : 'off'}`);

describe('applyNewerNodePushes', () => {
  const fetched = {
    payload: [node('elantris', true), node('patji', true)],
    requestedAt: REQUESTED_AT,
  };

  it('shows a node going offline after the fetch', () => {
    const merged = applyNewerNodePushes(
      fetched,
      pushesOf([node('patji', false), AFTER_REQUEST]),
    );
    expect(describeNodes(merged)).toEqual(['elantris:on', 'patji:off']);
  });

  it('keeps the fetch over a push it already contains', () => {
    const merged = applyNewerNodePushes(
      fetched,
      pushesOf([node('patji', false), BEFORE_REQUEST]),
    );
    expect(describeNodes(merged)).toEqual(['elantris:on', 'patji:on']);
  });

  it('adds a node that announced itself after the fetch, in slug order', () => {
    const merged = applyNewerNodePushes(
      fetched,
      pushesOf([node('braize', true), AFTER_REQUEST]),
    );
    expect(describeNodes(merged)).toEqual([
      'braize:on',
      'elantris:on',
      'patji:on',
    ]);
  });

  it('does not bring back a node the fetch no longer has', () => {
    const merged = applyNewerNodePushes(
      fetched,
      pushesOf([node('deleted', true), BEFORE_REQUEST]),
    );
    expect(describeNodes(merged)).toEqual(['elantris:on', 'patji:on']);
  });

  it('is empty until the first fetch answers', () => {
    expect(
      applyNewerNodePushes(null, pushesOf([node('patji', true), 0])),
    ).toEqual([]);
  });
});
