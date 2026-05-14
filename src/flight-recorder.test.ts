import { describe, it, expect } from 'vitest';
import {
  FlightRecorder,
  type ImpressionEvent,
  type CustomEvent,
} from './flight-recorder.js';

const unusedFetch: typeof fetch = async () => new Response();
const unusedClientKey = 'unused-client-key';

describe('FlightRecorder', () => {
  it('records an impression', () => {
    const recorder = new FlightRecorder({
      url: 'https://example/events',
      fetch: unusedFetch,
      clientKey: unusedClientKey,
    });
    const event: ImpressionEvent = {
      eventType: 'isEnabled',
      eventId: '11111111-1111-4111-8111-111111111111',
      context: { userId: 'u-42', sessionId: 's-7' },
      enabled: true,
      featureName: 'demo.flag',
    };
    recorder.record(event);
  });

  it('records a custom event', () => {
    const recorder = new FlightRecorder({
      url: 'https://example/events',
      fetch: unusedFetch,
      clientKey: unusedClientKey,
    });
    const event: CustomEvent = {
      eventType: 'custom',
      eventId: '22222222-2222-4222-8222-222222222222',
      context: { userId: 'u-42' },
      name: 'signup',
      payload: { plan: 'pro' },
    };
    recorder.record(event);
  });

  it('can flush with no events', async () => {
    const recorder = new FlightRecorder({
      url: 'https://example/events',
      fetch: unusedFetch,
      clientKey: unusedClientKey,
    });
    await recorder.flush();
  });

  it('ships recorded events to the configured url on flush', async () => {
    type Call = {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    const calls: Call[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: String(init?.body ?? ''),
      });
      return new Response();
    };

    const recorder = new FlightRecorder({
      url: 'https://example/events',
      fetch: fakeFetch,
      clientKey: 'default:development.real-key-shape',
    });
    const event: ImpressionEvent = {
      eventType: 'isEnabled',
      eventId: '11111111-1111-4111-8111-111111111111',
      context: {},
      enabled: true,
      featureName: 'demo.flag',
    };
    recorder.record(event);
    await recorder.flush();

    expect(calls).toEqual([
      {
        url: 'https://example/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/ndjson',
          Authorization: 'default:development.real-key-shape',
        },
        body: JSON.stringify(event) + '\n',
      },
    ]);
  });

  it('an event recorded mid-flush is sent on the next flush', async () => {
    const sentBodies: string[] = [];
    let releaseFirstFetch!: () => void;
    const firstFetchInFlight = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let isFirstFetch = true;
    const fakeFetch: typeof fetch = async (_input, init) => {
      sentBodies.push(String(init?.body ?? ''));
      if (isFirstFetch) {
        isFirstFetch = false;
        await firstFetchInFlight;
      }
      return new Response();
    };

    const recorder = new FlightRecorder({
      url: 'https://example/events',
      fetch: fakeFetch,
      clientKey: unusedClientKey,
    });
    const before: ImpressionEvent = {
      eventType: 'isEnabled',
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      context: {},
      enabled: true,
      featureName: 'before',
    };
    const during: ImpressionEvent = {
      eventType: 'isEnabled',
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      context: {},
      enabled: true,
      featureName: 'during',
    };

    recorder.record(before);
    const flushInFlight = recorder.flush();
    recorder.record(during);
    releaseFirstFetch();
    await flushInFlight;

    await recorder.flush();

    expect(sentBodies).toEqual([
      JSON.stringify(before) + '\n',
      JSON.stringify(during) + '\n',
    ]);
  });
});
