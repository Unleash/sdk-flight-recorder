import { describe, it } from 'vitest';
import {
  FlightRecorder,
  type ImpressionEvent,
  type CustomEvent,
} from './flight-recorder.js';

describe('FlightRecorder', () => {
  it('records an impression', () => {
    const recorder = new FlightRecorder();
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
    const recorder = new FlightRecorder();
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
    const recorder = new FlightRecorder();
    await recorder.flush();
  });
});
