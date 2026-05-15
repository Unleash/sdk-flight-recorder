import ky from 'ky';

export type HttpClient = {
    post(body: string, postOptions?: { keepalive?: boolean }): Promise<void>;
};

export type HttpClientOptions = {
    url: string;
    headers: Record<string, string>;
    fetch: typeof fetch;
    retries: number;
    retryDelay?: (attemptCount: number) => number;
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
    return {
        post: async (body, postOptions) => {
            await client.post(options.url, {
                body,
                keepalive: postOptions?.keepalive,
            });
        },
    };
};
