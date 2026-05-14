import ky from 'ky';

export type HttpClient = {
    post(body: string): Promise<void>;
};

export type HttpClientOptions = {
    url: string;
    headers: Record<string, string>;
    fetch: typeof fetch;
    retries: number;
};

export const createHttpClient = (options: HttpClientOptions): HttpClient => {
    const client = ky.create({
        fetch: options.fetch,
        retry: { limit: options.retries, methods: ['post'] },
        headers: options.headers,
    });
    return {
        post: async (body) => {
            await client.post(options.url, { body });
        },
    };
};
