import { createOtelFlightRecorder } from '../src/otel/flight-recorder.js';

const url = process.env.OTLP_URL ?? 'http://localhost:4318/v1/logs';
const wireFormat = (process.env.WIRE_FORMAT ?? 'json') as 'json' | 'protobuf';
const serviceName = process.env.SERVICE_NAME ?? 'e2e-client';

const recorder = createOtelFlightRecorder({
  url,
  wireFormat,
  serviceName,
  serviceVersion: '0.0.1',
});

console.log(`Sending events to ${url} as ${wireFormat} (serviceName=${serviceName})`);

recorder.record({
  eventType: 'isEnabled',
  context: { userId: 'e2e-user-1' },
  enabled: true,
  featureName: 'e2e.flag.enabled',
});

recorder.record({
  eventType: 'getVariant',
  context: { userId: 'e2e-user-1' },
  enabled: true,
  featureName: 'e2e.flag.variant',
  variant: 'treatment',
});

recorder.record({
  eventType: 'custom',
  context: { userId: 'e2e-user-1' },
  eventName: 'e2e.checkout.completed',
  payload: { amount: 99, currency: 'USD' },
});

await recorder.flush();
await recorder.close();

console.log('Flushed and closed');
