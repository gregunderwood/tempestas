import { Injectable } from '@nestjs/common';

/**
 * A record of times the hardware and the database disagreed about a relay.
 *
 * Kept because the policy on a divergence is "the hardware wins, and it raises
 * an alarm" - a disagreement means something already went wrong upstream, so
 * correcting the row quietly would destroy the only evidence that it happened.
 *
 * In memory on purpose, and the ERROR log is the durable record: this exists to
 * put the condition on a surface something already reads, not to become a
 * second audit trail beside the `devices` timestamps and journald.
 */
export interface Divergence {
  deviceName: string;
  nodeId: string;
  pin: number;
  /** What the hardware reported, which is the side that wins. */
  hardwareOn: boolean;
  reason: string;
  at: Date;
}

@Injectable()
export class DivergenceLog {
  // Bounded so a node flapping a line cannot grow this without limit.
  private static readonly CAP = 50;
  private readonly entries: Divergence[] = [];

  record(divergence: Divergence): void {
    this.entries.push(divergence);
    if (this.entries.length > DivergenceLog.CAP) {
      this.entries.splice(0, this.entries.length - DivergenceLog.CAP);
    }
  }

  since(cutoff: Date): readonly Divergence[] {
    return this.entries.filter((e) => e.at.getTime() >= cutoff.getTime());
  }
}
