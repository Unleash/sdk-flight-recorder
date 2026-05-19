// Reads the current wall-clock time as an ISO 8601 string. Injected so the
// recorder can stamp event timestamps without reaching for a global `Date`,
// and so tests can pin time to a fixed value.
export type Clock = {
  now(): string;
};

export const systemClock: Clock = {
  now() {
    return new Date().toISOString();
  },
};
