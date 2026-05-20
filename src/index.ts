import { type Clock, systemClock } from './clock.js';
import { EventBuffer } from './event-buffer.js';
import {
  type BatchOptions,
  DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER,
  type ErrorInfo,
  FlightRecorder,
  type StampedEvent,
} from './flight-recorder.js';
import { createHttpClient } from './http-client.js';
import type { Scheduler } from './scheduler.js';
import { semanticEventKey } from './semantic-event-key.js';
import { systemTimer } from './timer.js';
import { TimerScheduler } from './timer-scheduler.js';

export type {
  BatchOptions,
  CustomEvent,
  ErrorInfo,
  FlightRecorder,
  ImpressionEvent,
} from './flight-recorder.js';

const DEFAULT_BATCH: BatchOptions = {
  flushAt: 10_000,
  flushAfterMs: 10_000,
};

const DEFAULT_RETRY = { retries: 2 };

export type FlightRecorderOptions = {
  url: string;
  clientKey: string;
  batch?: Partial<BatchOptions>;
  fetch?: typeof fetch;
  scheduler?: Scheduler;
  clock?: Clock;
  retry?: { retries: number };
  onError?: (info: ErrorInfo) => void;
};

export const createFlightRecorder = (options: FlightRecorderOptions): FlightRecorder => {
  const batch: BatchOptions = { ...DEFAULT_BATCH, ...options.batch };
  const multiplier = batch.maxBufferSizeMultiplier ?? DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER;
  if (multiplier < 1) {
    throw new Error('batch.maxBufferSizeMultiplier must be >= 1');
  }
  const httpClient = createHttpClient({
    url: options.url,
    headers: {
      'content-type': 'application/ndjson',
      authorization: options.clientKey,
    },
    fetch: options.fetch ?? globalThis.fetch,
    retries: options.retry?.retries ?? DEFAULT_RETRY.retries,
  });
  const buffer = new EventBuffer<StampedEvent>({
    maxSize: batch.flushAt * multiplier,
    dedupKey: semanticEventKey,
  });
  return new FlightRecorder({
    httpClient,
    buffer,
    scheduler: options.scheduler ?? new TimerScheduler(systemTimer),
    clock: options.clock ?? systemClock,
    flushAt: batch.flushAt,
    flushAfterMs: batch.flushAfterMs,
    onError: options.onError,
  });
};
