import { afterEach, describe, expect, it } from 'vitest';
import { createFlightRecorder } from './index.js';

const defaultUrl = 'https://example/events';

describe('createFlightRecorder', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('ships events through an ambient fetch that rejects a detached receiver', async () => {
    let shipped = false;
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Can only call Window.fetch on instances of Window');
      }
      shipped = true;
      return Promise.resolve(new Response());
    } as typeof fetch;

    const recorder = createFlightRecorder({
      url: defaultUrl,
      clientKey: '',
      retry: { retries: 0 },
    });
    recorder.record({ eventType: 'custom', eventName: 'x', context: {} });
    await recorder.flush();

    expect(shipped).toBe(true);
  });
});
