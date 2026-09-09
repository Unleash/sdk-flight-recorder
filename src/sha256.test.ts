import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256.js';

const nodeSha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf-8').digest('hex');

describe('sha256Hex', () => {
  it('matches the Node crypto digest, including multi-byte input and block boundaries', () => {
    const inputs = ['user@example.com', '', 'zażółć@例え.jp', 'a'.repeat(55), 'a'.repeat(64)];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(nodeSha256Hex(input));
    }
  });
});
