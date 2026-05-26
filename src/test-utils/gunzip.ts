// Test-only inverse of `gzip` — decompresses gzipped bytes back to a string.
// Used by `gzip.test.ts` for round-trip verification and by other tests that
// need to inspect a compressed request body.
export const gunzip = async (bytes: Uint8Array | ArrayBuffer): Promise<string> =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
