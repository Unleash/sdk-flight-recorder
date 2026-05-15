import { describe, it, expect } from 'vitest';
import { createHttpClient } from './http-client.js';

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
