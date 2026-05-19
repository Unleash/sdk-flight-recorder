// A one-shot delayed callback — the only thing `TimerScheduler` needs from
// "time". `schedule` returns a cancel function. The callback may return a
// promise: `systemTimer` ignores it (fire-and-forget); `ControllableTimer`
// awaits it so a test can drive the scheduler tick-by-tick.
export type Timer = {
  schedule(ms: number, callback: () => void | Promise<void>): () => void;
};

export const systemTimer: Timer = {
  schedule(ms, callback) {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};

// In-memory `Timer` for tests: the pending callback fires only on `advance`.
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
