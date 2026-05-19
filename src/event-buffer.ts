export type AddResult = 'added' | 'duplicate' | 'overflow';

export class EventBuffer<T> {
  private readonly events: T[] = [];
  private readonly seen = new Set<string>();
  private readonly maxSize: number | undefined;
  private readonly dedupKey: (event: T) => string;

  constructor(options: { maxSize?: number; dedupKey: (event: T) => string }) {
    this.maxSize = options.maxSize;
    this.dedupKey = options.dedupKey;
  }

  get size(): number {
    return this.events.length;
  }

  add(event: T): AddResult {
    const key = this.dedupKey(event);
    if (this.seen.has(key)) return 'duplicate';
    if (this.maxSize !== undefined && this.events.length >= this.maxSize) {
      return 'overflow';
    }
    this.seen.add(key);
    this.events.push(event);
    return 'added';
  }

  drain(): T[] {
    const out = this.events.splice(0);
    this.seen.clear();
    return out;
  }
}
