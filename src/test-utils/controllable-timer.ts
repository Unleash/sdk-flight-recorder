import type { Timer } from '../timer.js';

// In-memory `Timer` for tests: the pending callback fires only on `advance`.
// `systemTimer` is fire-and-forget (drops the callback's promise);
// `ControllableTimer.advance` awaits it so a test can drive the scheduler
// tick-by-tick.
export class ControllableTimer implements Timer {
  private pending: { ms: number; callback: () => void | Promise<void> } | undefined;

  schedule(ms: number, callback: () => void | Promise<void>): () => void {
    const entry = { ms, callback };
    this.pending = entry;
    return () => {
      if (this.pending === entry) this.pending = undefined;
    };
  }

  async advance(ms: number): Promise<void> {
    let remaining = ms;
    while (this.pending !== undefined && this.pending.ms <= remaining) {
      remaining -= this.pending.ms;
      const { callback } = this.pending;
      this.pending = undefined;
      // Awaiting lets the scheduler re-arm `pending` before the next loop.
      await callback();
    }
  }
}
