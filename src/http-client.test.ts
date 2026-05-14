import { describe, it, expect } from 'vitest';
import { createHttpClient } from './http-client.js';

const defaultUrl = 'https://example/events';

describe('HttpClient', () => {
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
