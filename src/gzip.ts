// gzip-compresses a string using the platform-native CompressionStream.
// Works in Node 18+, modern browsers, Cloudflare Workers, Deno, Bun — anywhere
// the Web Streams API is available. No npm dep needed; the platform provides
// the compression algorithm.
export const gzip = async (body: string): Promise<Uint8Array> => {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
};
