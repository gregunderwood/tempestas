// An agent claims every line at its fail-safe level when it starts, so its first report after a new boot may disagree on purpose.
export class NodeBoots {
  private readonly bootIdByNode = new Map<string, string | null>();
  private readonly pinsReportedSinceBoot = new Map<string, Set<number>>();

  // A hello that lands while the stored boot ids load is newer, so it wins.
  rememberStoredBootId(nodeId: string, bootId: string | null): void {
    if (this.bootIdByNode.has(nodeId)) {
      return;
    }
    this.bootIdByNode.set(nodeId, bootId);
  }

  recordHello(nodeId: string, bootId: string): void {
    const previousBootId = this.bootIdByNode.get(nodeId);
    this.bootIdByNode.set(nodeId, bootId);
    // A null boot id predates the column, so a reboot is not provable.
    const hasProvablyRebooted =
      typeof previousBootId === 'string' && previousBootId !== bootId;
    if (hasProvablyRebooted) {
      this.pinsReportedSinceBoot.set(nodeId, new Set());
    }
  }

  isFirstReportSinceBoot(nodeId: string, pin: number): boolean {
    const reportedPins = this.pinsReportedSinceBoot.get(nodeId);
    if (!reportedPins || reportedPins.has(pin)) {
      return false;
    }
    reportedPins.add(pin);
    return true;
  }
}
