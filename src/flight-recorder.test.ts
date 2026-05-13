import { describe, it } from 'vitest';
import { FlightRecorder, type ImpressionEvent } from './flight-recorder.js';

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
});
