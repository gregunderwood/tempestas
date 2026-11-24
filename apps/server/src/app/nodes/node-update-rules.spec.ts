import {
  AgentApp,
  ApiErrorCode,
  NodeStatus,
  NodeUpdateOutcome,
  UpdateState,
} from '@tempestas/domain';
import type { UpdateStatusReport } from '../hardware/hardware.service';
import type { NodeEntity, NodeUpdateEntity } from './models';
import {
  applyUpdateStatus,
  FINAL_STATE_WAIT_MS,
  findRollBackVersion,
  findUpdateRefusal,
  isStalled,
  timeOut,
  type UpdateConditions,
} from './node-update-rules';

const STARTED_AT = new Date('2026-11-24T12:00:00Z');
const LATER = new Date('2026-11-24T12:01:00Z');

const READY: UpdateConditions = {
  isReleasesUrlSet: true,
  isLeader: true,
  updateInProgress: null,
};

function node(overrides: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id: 'node-uuid',
    slug: 'patji',
    status: NodeStatus.Admitted,
    online: true,
    agentName: AgentApp.Linux,
    agentVersion: '1.1.1',
    ...overrides,
  } as NodeEntity;
}

function update(overrides: Partial<NodeUpdateEntity> = {}): NodeUpdateEntity {
  return {
    id: 'update-1',
    nodeId: 'node-uuid',
    app: AgentApp.Linux,
    fromVersion: '1.1.0',
    toVersion: '1.1.1',
    isRollBack: false,
    lastState: null,
    outcome: NodeUpdateOutcome.InProgress,
    reason: null,
    startedAt: STARTED_AT,
    finishedAt: null,
    ...overrides,
  } as NodeUpdateEntity;
}

function status(
  state: UpdateState,
  reason: string | null = null,
): UpdateStatusReport {
  return { nodeId: 'patji', id: 'update-1', state, reason };
}

describe('findUpdateRefusal', () => {
  it('allows an admitted, online node when nothing else is updating', () => {
    expect(findUpdateRefusal(node(), READY)).toBeNull();
  });

  it.each([
    [
      'no releases address',
      node(),
      { ...READY, isReleasesUrlSet: false },
      ApiErrorCode.UpdatesNotConfigured,
    ],
    [
      'a follower',
      node(),
      { ...READY, isLeader: false },
      ApiErrorCode.ControllerIsFollower,
    ],
    [
      'a pending node',
      node({ status: NodeStatus.Pending }),
      READY,
      ApiErrorCode.NodeNotAdmitted,
    ],
    [
      'an offline node',
      node({ online: false }),
      READY,
      ApiErrorCode.NodeOffline,
    ],
    [
      'another node updating',
      node(),
      { ...READY, updateInProgress: { nodeSlug: 'elantris' } },
      ApiErrorCode.UpdateInProgress,
    ],
  ])('refuses %s', (_case, candidate, conditions, code) => {
    expect(findUpdateRefusal(candidate, conditions)?.code).toBe(code);
  });

  it('names the node that is updating', () => {
    expect(
      findUpdateRefusal(node(), {
        ...READY,
        updateInProgress: { nodeSlug: 'elantris' },
      })?.message,
    ).toContain('"elantris" is updating');
  });
});

describe('findRollBackVersion', () => {
  it('offers the version from before the last healthy update', () => {
    expect(
      findRollBackVersion(
        node(),
        update({ outcome: NodeUpdateOutcome.Healthy }),
      ),
    ).toBe('1.1.0');
  });

  it('offers nothing once the node runs another version', () => {
    expect(
      findRollBackVersion(
        node({ agentVersion: '1.1.2' }),
        update({ outcome: NodeUpdateOutcome.Healthy }),
      ),
    ).toBeNull();
  });

  it('does not offer to undo a roll back', () => {
    expect(
      findRollBackVersion(
        node({ agentVersion: '1.1.0' }),
        update({
          fromVersion: '1.1.1',
          toVersion: '1.1.0',
          isRollBack: true,
          outcome: NodeUpdateOutcome.Healthy,
        }),
      ),
    ).toBeNull();
  });

  it('offers nothing without a healthy update', () => {
    expect(findRollBackVersion(node(), null)).toBeNull();
  });
});

describe('applyUpdateStatus', () => {
  it('records progress without finishing the update', () => {
    const inProgress = update();

    expect(
      applyUpdateStatus(inProgress, status(UpdateState.Installing), LATER),
    ).toBe(true);
    expect(inProgress).toMatchObject({
      lastState: UpdateState.Installing,
      outcome: NodeUpdateOutcome.InProgress,
      finishedAt: null,
    });
  });

  it.each([
    [UpdateState.Healthy, NodeUpdateOutcome.Healthy],
    [UpdateState.RolledBack, NodeUpdateOutcome.RolledBack],
    [UpdateState.Failed, NodeUpdateOutcome.Failed],
  ])('finishes the update on %s', (state, outcome) => {
    const inProgress = update();

    applyUpdateStatus(inProgress, status(state, 'why'), LATER);

    expect(inProgress).toMatchObject({
      outcome,
      reason: 'why',
      finishedAt: LATER,
    });
  });

  it('lets a late final state replace a time-out, because the node knows better', () => {
    const timedOut = update({ outcome: NodeUpdateOutcome.TimedOut });

    expect(
      applyUpdateStatus(timedOut, status(UpdateState.Healthy), LATER),
    ).toBe(true);
    expect(timedOut.outcome).toBe(NodeUpdateOutcome.Healthy);
  });

  it('ignores late progress after a time-out', () => {
    const timedOut = update({ outcome: NodeUpdateOutcome.TimedOut });

    expect(
      applyUpdateStatus(timedOut, status(UpdateState.Installing), LATER),
    ).toBe(false);
    expect(timedOut.outcome).toBe(NodeUpdateOutcome.TimedOut);
  });

  it('never reopens a finished update', () => {
    const healthy = update({ outcome: NodeUpdateOutcome.Healthy });

    expect(applyUpdateStatus(healthy, status(UpdateState.Failed), LATER)).toBe(
      false,
    );
    expect(healthy.outcome).toBe(NodeUpdateOutcome.Healthy);
  });
});

describe('stalled updates', () => {
  const waitedOut = new Date(STARTED_AT.getTime() + FINAL_STATE_WAIT_MS);

  it('stalls only once the wait has passed', () => {
    expect(isStalled(update(), LATER)).toBe(false);
    expect(isStalled(update(), waitedOut)).toBe(true);
    expect(
      isStalled(update({ outcome: NodeUpdateOutcome.Healthy }), waitedOut),
    ).toBe(false);
  });

  it('times out with the last state heard', () => {
    const stalled = update({ lastState: UpdateState.Restarting });

    timeOut(stalled, waitedOut);

    expect(stalled).toMatchObject({
      outcome: NodeUpdateOutcome.TimedOut,
      finishedAt: waitedOut,
    });
    expect(stalled.reason).toContain('"restarting"');
  });

  it('says when nothing at all was heard', () => {
    const silent = update();

    timeOut(silent, waitedOut);

    expect(silent.reason).toContain('nothing was heard');
  });
});
