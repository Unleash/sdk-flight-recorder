import { describe, expect, it } from 'vitest';
import { EventBuffer } from './event-buffer.js';

const makeEvent = ({ id, occurrenceCount = 1 }: { id: number; occurrenceCount?: number }) => ({
  id,
  occurrenceCount,
});

describe('EventBuffer', () => {
  it('classifies events as added, duplicate, or overflow; drain resets the window', () => {
    const buffer = new EventBuffer<{ id: number; occurrenceCount: number }>({
      maxSize: 1,
      dedupKey: (e) => String(e.id),
    });

    expect(buffer.size).toBe(0);
    expect(buffer.add(makeEvent({ id: 1 }))).toBe('added');
    expect(buffer.size).toBe(1);
    expect(buffer.add(makeEvent({ id: 1 }))).toBe('duplicate');
    expect(buffer.add(makeEvent({ id: 2 }))).toBe('overflow');

    expect(buffer.drain()).toEqual([{ id: 1, occurrenceCount: 2 }]);
    expect(buffer.size).toBe(0);
    expect(buffer.add(makeEvent({ id: 1 }))).toBe('added');
  });

  it('counts how many times each event was recorded in the window', () => {
    const buffer = new EventBuffer<{ id: number; occurrenceCount: number }>({
      dedupKey: (e) => String(e.id),
    });

    buffer.add(makeEvent({ id: 1 }));
    buffer.add(makeEvent({ id: 1 }));
    buffer.add(makeEvent({ id: 1 }));
    buffer.add(makeEvent({ id: 2 }));

    expect(buffer.drain()).toEqual([
      { id: 1, occurrenceCount: 3 },
      { id: 2, occurrenceCount: 1 },
    ]);
  });

  it('dedupes by the injected key, not by event identity', () => {
    const buffer = new EventBuffer<{ id: number; tag: string; occurrenceCount: number }>({
      dedupKey: (e) => e.tag,
    });

    expect(buffer.add({ id: 1, tag: 'x', occurrenceCount: 1 })).toBe('added');
    expect(buffer.add({ id: 2, tag: 'x', occurrenceCount: 1 })).toBe('duplicate');
    expect(buffer.add({ id: 3, tag: 'y', occurrenceCount: 1 })).toBe('added');
  });

  it('accumulates an explicit occurrence count across adds', () => {
    const buffer = new EventBuffer<{ id: number; occurrenceCount: number }>({
      dedupKey: (e) => String(e.id),
    });

    buffer.add(makeEvent({ id: 1, occurrenceCount: 2 }));
    buffer.add(makeEvent({ id: 1, occurrenceCount: 3 }));

    expect(buffer.drain()).toEqual([{ id: 1, occurrenceCount: 5 }]);
  });

  it('does not mutate the original event object when a duplicate is merged', () => {
    const buffer = new EventBuffer<{ id: number; occurrenceCount: number }>({
      dedupKey: (e) => String(e.id),
    });
    const stored = makeEvent({ id: 1, occurrenceCount: 7 });
    buffer.add(stored);

    buffer.add(makeEvent({ id: 1, occurrenceCount: 3 }));

    expect(stored.occurrenceCount).toBe(7);
    expect(buffer.drain()).toEqual([{ id: 1, occurrenceCount: 10 }]);
  });
});
