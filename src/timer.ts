// A one-shot delayed callback — the only thing `TimerScheduler` needs from
// "time". `schedule` returns a cancel function. The callback may return a
// promise: `systemTimer` ignores it (fire-and-forget); tests inject
// `ControllableTimer` (in `src/test-utils/`), which awaits it so the test can
// drive the scheduler tick-by-tick.
export type Timer = {
  schedule(ms: number, callback: () => void | Promise<void>): () => void;
};

export const systemTimer: Timer = {
  schedule(ms, callback) {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};
