export type AddResult = 'added' | 'duplicate' | 'overflow';

// A drained event is the buffered event flattened with the number of times it
// was recorded in the window. `occurrenceCount` is 1 when no duplicates were seen.
export type DrainedEvent<T> = T & { occurrenceCount: number };

export class EventBuffer<T extends object> {
  // Storage holds the count *beside* the event (not on it) so a duplicate can
  // bump the counter in place — no per-duplicate re-spread on the hot path.
  private readonly events = new Map<string, { event: T; occurrenceCount: number }>();
  private readonly maxSize: number | undefined;
  private readonly dedupKey: (event: T) => string;

  constructor(options: { maxSize?: number; dedupKey: (event: T) => string }) {
    this.maxSize = options.maxSize;
    this.dedupKey = options.dedupKey;
  }

  get size(): number {
    return this.events.size;
  }

  add(event: T): AddResult {
    const key = this.dedupKey(event);
    const entry = this.events.get(key);
    if (entry !== undefined) {
      entry.occurrenceCount++;
      return 'duplicate';
    }
    if (this.maxSize !== undefined && this.events.size >= this.maxSize) {
      return 'overflow';
    }
    this.events.set(key, { event, occurrenceCount: 1 });
    return 'added';
  }

  drain(): DrainedEvent<T>[] {
    const result = Array.from(this.events.values(), ({ event, occurrenceCount }) => ({
      ...event,
      occurrenceCount,
    }));
    this.events.clear();
    return result;
  }
}
