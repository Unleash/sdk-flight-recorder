// A latch you can `await` and `open` from two different sides. Used by tests
// that need to hold async work mid-execution, set up further state, then
// release.
export const createGate = (): { opened: Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

// A `fetch` impl that parks every request behind a single gate. Call
// `release()` once and all in-flight + future calls resolve. Lets a test
// drive the recorder past `flushAt`/cap thresholds while sends are stuck.
export type GatedFetch = typeof fetch & {
  release: () => void;
};

export const createGatedFetch = (): GatedFetch => {
  const gate = createGate();
  const fetchImpl: typeof fetch = async () => {
    await gate.opened;
    return new Response();
  };
  return Object.assign(fetchImpl, { release: gate.open });
};
