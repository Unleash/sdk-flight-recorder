import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256Hex } from './sha256.js';

const nodeSha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf-8').digest('hex');

it('produces the same digest as Node crypto', () => {
  expect(sha256Hex('user@example.com')).toBe(nodeSha256Hex('user@example.com'));
});

it('encodes non-ascii input as utf-8, like Node', () => {
  expect(sha256Hex('zażółć@例え.jp')).toBe(nodeSha256Hex('zażółć@例え.jp'));
});
