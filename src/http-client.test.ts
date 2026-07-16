import { describe, expect, it } from 'vitest';
import { createHttpClient } from './http-client.js';
import { gunzip } from './test-utils/gunzip.js';

const defaultUrl = 'https://example/events';

describe('HttpClient', () => {
  it('forwards keepalive to fetch when post is called with keepalive', async () => {
    let capturedKeepalive: boolean | undefined;
    const fakeFetch: typeof fetch = async (input) => {
      capturedKeepalive = (input as Request).keepalive;
      return new Response();
    };

    const client = createHttpClient({
      url: defaultUrl,
      headers: {},
      fetch: fakeFetch,
      retries: 0,
    });
    await client.post('body', { keepalive: true });

    expect(capturedKeepalive).toBe(true);
  });

  it('compresses the body with gzip and sets content-encoding by default', async () => {
    let capturedBody: ArrayBuffer | undefined;
    let capturedEncoding: string | null = null;
    const fakeFetch: typeof fetch = async (input) => {
      const req = input as Request;
      capturedEncoding = req.headers.get('content-encoding');
      capturedBody = await req.arrayBuffer();
      return new Response();
    };

    const client = createHttpClient({
      url: defaultUrl,
      headers: {},
      fetch: fakeFetch,
      retries: 0,
    });
    await client.post('hello world');

    expect(capturedEncoding).toBe('gzip');
    expect(await gunzip(capturedBody ?? new ArrayBuffer(0))).toBe('hello world');
  });

  it('rejects with the response status when the server returns an error status', async () => {
    const fakeFetch: typeof fetch = async () => new Response(null, { status: 400 });

    const client = createHttpClient({
      url: defaultUrl,
      headers: {},
      fetch: fakeFetch,
      retries: 0,
    });

    await expect(client.post('body')).rejects.toMatchObject({ status: 400 });
  });

  it('network failures propagate the underlying error, not the transport wrapper', async () => {
    const networkError = new TypeError('Failed to fetch');
    const fakeFetch: typeof fetch = async () => {
      throw networkError;
    };

    const client = createHttpClient({
      url: defaultUrl,
      headers: {},
      fetch: fakeFetch,
      retries: 0,
    });

    await expect(client.post('body')).rejects.toBe(networkError);
  });

  it('retries POST requests when retries is configured', async () => {
    let attemptCount = 0;
    const fakeFetch: typeof fetch = async () => {
      attemptCount++;
      if (attemptCount === 1) throw new TypeError('Failed to fetch');
      return new Response();
    };

    const client = createHttpClient({
      url: defaultUrl,
      headers: {},
      fetch: fakeFetch,
      retries: 1,
      retryDelay: () => 0,
    });
    await client.post('body');

    expect(attemptCount).toBe(2);
  });
});
