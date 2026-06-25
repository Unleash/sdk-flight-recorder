import { type Clock, systemClock } from './clock.js';
import {
  type BatchOptions,
  createRecorderBuffer,
  DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER,
  type ErrorInfo,
  FlightRecorder,
} from './flight-recorder.js';
import { createHttpClient } from './http-client.js';
import type { Scheduler } from './scheduler.js';
import { systemTimer } from './timer.js';
import { TimerScheduler } from './timer-scheduler.js';

export type {
  AdminEvent,
  BatchOptions,
  CustomEvent,
  ErrorInfo,
  FlightRecorder,
  ImpressionEvent,
} from './flight-recorder.js';

// flushAt is a ceiling, not a target: the 10s timer does the routine
// flushing, so the buffer only reaches 10k under sustained load (>~1k
// events/s), where it caps memory at ~3.5 MB/batch over a normal fetch. A
// browser caller that bursts past ~180 events between flushes should override
// `batch` — a 10k keepalive flush on close() exceeds the 64 KB browser limit.
// `maxBufferSizeMultiplier` is left implicit so the library-side default
// (`DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER` = 2) is the single source of truth —
// effective cap is 2 × flushAt = 20k events (~7 MB at 350 bytes/event).
const DEFAULT_BATCH: BatchOptions = {
  flushAt: 10_000,
  flushAfterMs: 10_000,
};

// Two retries — ky's own default. ky retries the POST on transient failures
// (network errors, 429, 5xx) with exponential backoff and honours Retry-After,
// so a brief blip doesn't drop a whole batch.
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
  // Defaults to true. gzip-compresses outgoing batches; the API decompresses
  // transparently. Cuts wire size ~5-10x on typical NDJSON event batches —
  // helpful for keepalive (browser 64 KB limit) and any cellular/metered
  // network. Set to false only when wire-level inspection is needed.
  compress?: boolean;
};

// Composition root: wires the production collaborators — the global fetch
// (present in Node >=20 and browsers), a TimerScheduler over the real
// setTimeout, and the system clock that stamps event timestamps — plus sane
// default batching and retry policies, so callers don't repeat that
// boilerplate. Callers can override any of them; tests inject fakes via the
// same entry point.
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
    // Bind to globalThis: browsers' Window.fetch throws "Can only call
    // Window.fetch on instances of Window" when invoked detached, and ky calls
    // the injected fetch as a bare reference.
    fetch: (options.fetch ?? globalThis.fetch).bind(globalThis),
    retries: options.retry?.retries ?? DEFAULT_RETRY.retries,
    compress: options.compress,
  });
  const buffer = createRecorderBuffer({ maxSize: batch.flushAt * multiplier });
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
