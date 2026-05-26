import { expect, it } from 'vitest';
import { gzip } from './gzip.js';
import { gunzip } from './test-utils/gunzip.js';

it('compresses a string into bytes that decompress back to the original', async () => {
  const compressed = await gzip('hello world');

  expect(await gunzip(compressed)).toBe('hello world');
});

it('preserves multi-byte utf-8 characters through compress/decompress', async () => {
  const input = '日本語 emoji 🎉 — multibyte everything';

  const compressed = await gzip(input);

  expect(await gunzip(compressed)).toBe(input);
});
