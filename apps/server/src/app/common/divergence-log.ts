import { Injectable } from '@nestjs/common';

export interface Divergence {
  deviceName: string;
  nodeId: string;
  pin: number;
  hardwareOn: boolean;
  reason: string;
  at: Date;
}

// In memory on purpose: the ERROR log is the durable record. See docs/Safety.md, "The hardware wins".
@Injectable()
export class DivergenceLog {
  // Bounded so a node flapping a line cannot grow this without limit.
  private static readonly MAX_ENTRIES = 50;
  private readonly entries: Divergence[] = [];

  record(divergence: Divergence): void {
    this.entries.push(divergence);
    if (this.entries.length > DivergenceLog.MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - DivergenceLog.MAX_ENTRIES);
    }
  }

  since(cutoff: Date): readonly Divergence[] {
    return this.entries.filter(
      (entry) => entry.at.getTime() >= cutoff.getTime(),
    );
  }
}
