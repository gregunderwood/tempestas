import { PerDeviceQueue } from './per-device-queue';

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('PerDeviceQueue', () => {
  it('runs a device task only after the one before it settles', async () => {
    const queue = new PerDeviceQueue();
    const order: string[] = [];
    const first = deferred();

    const running = queue.runInTurn('dev-1', async () => {
      await first.promise;
      order.push('first');
    });
    const waiting = queue.runInTurn('dev-1', async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    first.release();
    await Promise.all([running, waiting]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs the next task even when the one before it fails', async () => {
    const queue = new PerDeviceQueue();
    const failing = queue.runInTurn('dev-1', async () => {
      throw new Error('refused');
    });
    const next = queue.runInTurn('dev-1', async () => 'ran');
    await expect(failing).rejects.toThrow('refused');
    await expect(next).resolves.toBe('ran');
  });

  it('does not hold one device behind another', async () => {
    const queue = new PerDeviceQueue();
    const blocked = deferred();
    void queue.runInTurn('dev-1', () => blocked.promise);
    await expect(queue.runInTurn('dev-2', async () => 'ran')).resolves.toBe(
      'ran',
    );
    blocked.release();
  });
});
