import { context, trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { expect, it } from 'vitest';
import type { CustomEvent, ImpressionEvent } from '../flight-recorder.js';
import { createOtelFlightRecorder, type OtelFlightRecorderOptions } from './flight-recorder.js';
import { CapturingExporter } from './test-utils/capturing-exporter.js';
import { startCapturingHttpServer } from './test-utils/capturing-http-server.js';
import { SyncContextManager } from './test-utils/sync-context-manager.js';

const defaultServiceName = 'default-service';
const defaultServiceVersion = '0.0.0';

const createRecorder = (overrides: Partial<OtelFlightRecorderOptions> = {}) =>
  createOtelFlightRecorder({
    exporter: new InMemoryLogRecordExporter(),
    serviceName: defaultServiceName,
    serviceVersion: defaultServiceVersion,
    ...overrides,
  });

const makeImpressionEvent = (overrides: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
  eventType: 'isEnabled',
  context: {},
  enabled: true,
  featureName: 'default.flag',
  ...overrides,
});

const makeCustomEvent = (overrides: Partial<CustomEvent> = {}): CustomEvent => ({
  eventType: 'custom',
  context: {},
  eventName: 'default.event',
  ...overrides,
});

it('ships a recorded event on flush', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent());
  await recorder.flush();

  expect(exporter.getFinishedLogRecords()).toHaveLength(1);
});

it('encodes the feature name as feature_flag.key', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'feature_flag.key': 'demo.flag' });
});

it('emits an impression event with event name feature_flag.evaluation', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent());
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.eventName).toBe('feature_flag.evaluation');
});

it('encodes enabled as feature_flag.result.value', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent({ enabled: false }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'feature_flag.result.value': false });
});

it('encodes variant as feature_flag.result.variant', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent({ eventType: 'getVariant', variant: 'treatment' }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'feature_flag.result.variant': 'treatment' });
});

it('emits a custom event with namespaced unleash.event.<name> as event name', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeCustomEvent({ eventName: 'checkout-completed' }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.eventName).toBe('unleash.event.checkout-completed');
});

it('encodes custom event payload as namespaced payload.* attributes', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeCustomEvent({ payload: { amount: 99, currency: 'USD' } }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({
    'payload.amount': 99,
    'payload.currency': 'USD',
  });
});

it('encodes impression event context as namespaced context.* attributes', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent({ context: { userId: 'u-7' } }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'context.userId': 'u-7' });
});

it('encodes custom event context as namespaced context.* attributes', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeCustomEvent({ context: { sessionId: 's-91' } }));
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'context.sessionId': 's-91' });
});

it('tags impression events with feature_flag.provider.name unleash', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent());
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.attributes).toMatchObject({ 'feature_flag.provider.name': 'unleash' });
});

it('attaches the configured service name as a resource attribute', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter, serviceName: 'checkout-frontend' });

  recorder.record(makeImpressionEvent());
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.resource.attributes).toMatchObject({ 'service.name': 'checkout-frontend' });
});

it('attaches the configured service version as a resource attribute', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter, serviceVersion: '1.4.2' });

  recorder.record(makeImpressionEvent());
  await recorder.flush();

  const [record] = exporter.getFinishedLogRecords();
  expect(record?.resource.attributes).toMatchObject({ 'service.version': '1.4.2' });
});

it('drops duplicate events with the same semantic key within one flush window', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
  recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
  await recorder.flush();

  expect(exporter.getFinishedLogRecords()).toHaveLength(1);
});

it('ships pending events on close', async () => {
  const exporter = new CapturingExporter();
  const recorder = createRecorder({ exporter });

  recorder.record(makeImpressionEvent());
  await recorder.close();

  expect(exporter.captured).toHaveLength(1);
});

it('does not ship events recorded after close', async () => {
  const exporter = new CapturingExporter();
  const recorder = createRecorder({ exporter });

  await recorder.close();
  recorder.record(makeImpressionEvent());
  await recorder.flush();

  expect(exporter.captured).toHaveLength(0);
});

it('ships an event as OTLP/JSON to the configured url when wireFormat is json', async () => {
  const server = await startCapturingHttpServer();
  try {
    const recorder = createOtelFlightRecorder({
      url: server.url,
      wireFormat: 'json',
      serviceName: defaultServiceName,
      serviceVersion: defaultServiceVersion,
    });

    recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
    await recorder.flush();

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/json');
    const body = JSON.parse(request?.body.toString('utf-8') ?? '{}');
    expect(body.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]?.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'feature_flag.key',
          value: expect.objectContaining({ stringValue: 'demo.flag' }),
        }),
      ]),
    );
  } finally {
    await server.close();
  }
});

it('attaches the active trace and span ids to recorded events', async () => {
  context.setGlobalContextManager(new SyncContextManager());
  try {
    const exporter = new CapturingExporter();
    const recorder = createRecorder({ exporter });
    const activeSpanContext = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    };

    context.with(trace.setSpanContext(context.active(), activeSpanContext), () => {
      recorder.record(makeImpressionEvent());
    });
    await recorder.flush();

    const [record] = exporter.captured;
    expect(record?.spanContext).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
    });
  } finally {
    context.disable();
  }
});

it('ships an event as OTLP/protobuf to the configured url when wireFormat is protobuf', async () => {
  const server = await startCapturingHttpServer();
  try {
    const recorder = createOtelFlightRecorder({
      url: server.url,
      wireFormat: 'protobuf',
      serviceName: defaultServiceName,
      serviceVersion: defaultServiceVersion,
    });

    recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
    await recorder.flush();

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/x-protobuf');
    expect(request?.body.byteLength).toBeGreaterThan(0);
    expect(request?.body.toString('utf-8')).toContain('demo.flag');
  } finally {
    await server.close();
  }
});
