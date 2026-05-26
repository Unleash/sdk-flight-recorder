import ky from 'ky';
import { gzip } from './gzip.js';

export type HttpClient = {
  post(body: string, postOptions?: { keepalive?: boolean }): Promise<void>;
};

export type HttpClientOptions = {
  url: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  retries: number;
  retryDelay?: (attemptCount: number) => number;
  // Defaults to true. gzip-compresses the body and sets `Content-Encoding: gzip`.
  // Cuts wire size 5-10x on NDJSON event batches; the API decompresses
  // transparently. Set to `false` only when wire-level inspection is needed
  // (debugging, certain test setups).
  compress?: boolean;
};

export const createHttpClient = (options: HttpClientOptions): HttpClient => {
  const client = ky.create({
    fetch: options.fetch,
    retry: {
      limit: options.retries,
      methods: ['post'],
      ...(options.retryDelay ? { delay: options.retryDelay } : {}),
    },
    headers: options.headers,
  });
  const shouldCompress = options.compress ?? true;
  return {
    post: async (body, postOptions) => {
      if (shouldCompress) {
        await client.post(options.url, {
          body: await gzip(body),
          headers: { 'content-encoding': 'gzip' },
          keepalive: postOptions?.keepalive,
        });
        return;
      }
      await client.post(options.url, {
        body,
        keepalive: postOptions?.keepalive,
      });
    },
  };
};
