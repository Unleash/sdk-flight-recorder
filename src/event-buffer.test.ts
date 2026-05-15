import { describe, it, expect } from 'vitest';
import { EventBuffer } from './event-buffer.js';

const e1 = { id: 1 };
const e2 = { id: 2 };

describe('EventBuffer', () => {
    it('classifies events as added, duplicate, or overflow; drain resets the window', () => {
        const buffer = new EventBuffer({ maxSize: 1 });

        expect(buffer.size).toBe(0);
        expect(buffer.add(e1)).toBe('added');
        expect(buffer.size).toBe(1);
        expect(buffer.add(e1)).toBe('duplicate');
        expect(buffer.add(e2)).toBe('overflow');

        expect(buffer.drain()).toEqual([e1]);
        expect(buffer.size).toBe(0);
        expect(buffer.add(e1)).toBe('added');
    });
});
