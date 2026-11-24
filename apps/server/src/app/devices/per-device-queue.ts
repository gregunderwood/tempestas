// In-process only: this server is the sole writer of device rows.
export class PerDeviceQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  runInTurn<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(deviceId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => undefined);
    this.tails.set(deviceId, tail);
    void tail.then(() => this.forgetIfLast(deviceId, tail));
    return result;
  }

  private forgetIfLast(deviceId: string, tail: Promise<unknown>): void {
    if (this.tails.get(deviceId) === tail) this.tails.delete(deviceId);
  }
}
