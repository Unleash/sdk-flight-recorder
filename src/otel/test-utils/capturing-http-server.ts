import { createServer, type Server } from 'node:http';

export type CapturedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
};

export type CapturingHttpServer = {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

// Starts an HTTP server bound to a random port on 127.0.0.1, accumulates every
// request it receives, and returns 200 OK with an empty OTLP partial-success
// body so the OTel exporter treats each call as successful.
export const startCapturingHttpServer = (): Promise<CapturingHttpServer> => {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({
      path: req.url ?? '',
      method: req.method ?? '',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(',') : (v ?? ''),
        ]),
      ),
      body: Buffer.concat(chunks),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1/logs`,
        requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
};
