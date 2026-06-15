export type AddResult = 'added' | 'duplicate' | 'overflow';

export class EventBuffer<T extends { occurrenceCount: number }> {
  private readonly events = new Map<string, T>();
  private readonly maxSize: number | undefined;
  private readonly dedupKey: (event: T) => string;

  constructor(options: { maxSize?: number; dedupKey: (event: T) => string }) {
    this.maxSize = options.maxSize;
    this.dedupKey = options.dedupKey;
  }

  get size(): number {
    return this.events.size;
  }

  // The stored event carries its own `occurrenceCount`. A collision merges the
  // counts into a fresh copy rather than mutating in place: the buffer never
  // writes to an object a caller still holds (drained events stay live during an
  // in-flight send), so re-adding any reference — even the stored one — is safe.
  // A fresh record (count 1) and a re-added batch (count N) merge the same way.
  add(event: T): AddResult {
    const key = this.dedupKey(event);
    const entry = this.events.get(key);
    if (entry !== undefined) {
      this.events.set(key, {
        ...entry,
        occurrenceCount: entry.occurrenceCount + event.occurrenceCount,
      });
      return 'duplicate';
    }
    if (this.maxSize !== undefined && this.events.size >= this.maxSize) {
      return 'overflow';
    }
    this.events.set(key, event);
    return 'added';
  }

  drain(): T[] {
    const result = Array.from(this.events.values());
    this.events.clear();
    return result;
  }
}
