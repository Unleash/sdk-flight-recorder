export type AddResult = 'added' | 'duplicate' | 'overflow';

export type DrainedEvent<T> = { event: T; occurrenceCount: number };

export class EventBuffer<T> {
  private readonly events = new Map<string, DrainedEvent<T>>();
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
    const result = Array.from(this.events.values());
    this.events.clear();
    return result;
  }
}
