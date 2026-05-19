import { describe, expect, it } from 'vitest';
import { toNdjson } from './ndjson.js';

describe('toNdjson', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    expect(toNdjson([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });
});
