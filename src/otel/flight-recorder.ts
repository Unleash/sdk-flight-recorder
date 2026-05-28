import type { LogAttributes } from '@opentelemetry/api-logs';
import { OTLPLogExporter as OTLPLogExporterJson } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterProto } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import type { CustomEvent, ImpressionEvent } from '../flight-recorder.js';
import { semanticEventKey } from '../semantic-event-key.js';

export type WireFormat = 'json' | 'protobuf';

// Provide exactly one of `exporter` (for tests) or `url` (for production).
export type OtelFlightRecorderOptions = {
  serviceName: string;
  serviceVersion: string;
  exporter?: LogRecordExporter;
  url?: string;
  wireFormat?: WireFormat;
};

const buildExporter = (options: OtelFlightRecorderOptions): LogRecordExporter => {
  if (options.exporter !== undefined) return options.exporter;
  if (options.url === undefined) {
    throw new Error('OtelFlightRecorder requires either an exporter or a url');
  }
  if (options.wireFormat === 'protobuf') {
    return new OTLPLogExporterProto({ url: options.url });
  }
  return new OTLPLogExporterJson({ url: options.url });
};

export type OtelFlightRecorder = {
  record(event: ImpressionEvent | CustomEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};

// Flattens a one-level JSON-like map into dot-prefixed OTLP attribute keys.
// Values that aren't AnyValue primitives are JSON-stringified so they still
// survive the wire format (which only accepts string/number/boolean/etc.).
const flattenInto = (
  target: LogAttributes,
  prefix: string,
  source: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    const attributeKey = `${prefix}.${key}`;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      target[attributeKey] = value;
    } else {
      target[attributeKey] = JSON.stringify(value);
    }
  }
};

export const createOtelFlightRecorder = (
  options: OtelFlightRecorderOptions,
): OtelFlightRecorder => {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
    }),
    processors: [new BatchLogRecordProcessor(buildExporter(options))],
  });
  const logger = provider.getLogger('@unleash/sdk-flight-recorder');
  const seenKeys = new Set<string>();
  let closed = false;

  return {
    record(event) {
      if (closed) return;
      const key = semanticEventKey(event);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      if (event.eventType === 'custom') {
        const attributes: LogAttributes = {};
        if (event.payload) flattenInto(attributes, 'payload', event.payload);
        flattenInto(attributes, 'context', event.context);
        logger.emit({
          eventName: `unleash.event.${event.eventName}`,
          attributes,
        });
        return;
      }
      const attributes: LogAttributes = {
        'feature_flag.key': event.featureName,
        'feature_flag.provider.name': 'unleash',
        'feature_flag.result.value': event.enabled,
      };
      if (event.variant !== undefined) {
        attributes['feature_flag.result.variant'] = event.variant;
      }
      flattenInto(attributes, 'context', event.context);
      logger.emit({
        eventName: 'feature_flag.evaluation',
        attributes,
      });
    },
    async flush() {
      if (closed) return;
      await provider.forceFlush();
      seenKeys.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      await provider.shutdown();
    },
  };
};
