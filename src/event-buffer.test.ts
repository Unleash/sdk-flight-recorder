import { describe, it, expect } from 'vitest';
import { EventBuffer } from './event-buffer.js';

const e1 = { id: 1 };
const e2 = { id: 2 };

describe('EventBuffer', () => {
    it('classifies events as added, duplicate, or overflow; drain resets the window', () => {
        const buffer = new EventBuffer({ maxSize: 1, dedupKey: JSON.stringify });

        expect(buffer.size).toBe(0);
        expect(buffer.add(e1)).toBe('added');
        expect(buffer.size).toBe(1);
        expect(buffer.add(e1)).toBe('duplicate');
        expect(buffer.add(e2)).toBe('overflow');

        expect(buffer.drain()).toEqual([e1]);
        expect(buffer.size).toBe(0);
        expect(buffer.add(e1)).toBe('added');
    });

    it('dedupes by the injected key, not by event identity', () => {
        const buffer = new EventBuffer<{ id: number; tag: string }>({
            dedupKey: (e) => e.tag,
        });

        expect(buffer.add({ id: 1, tag: 'x' })).toBe('added');
        expect(buffer.add({ id: 2, tag: 'x' })).toBe('duplicate');
        expect(buffer.add({ id: 3, tag: 'y' })).toBe('added');
    });
});
