import { FlightRecorder } from './flight-recorder.js';
import type { BatchOptions, FlightRecorderOptions } from './flight-recorder.js';
import { TimerScheduler } from './timer-scheduler.js';
import { systemTimer } from './timer.js';

export type { FlightRecorder } from './flight-recorder.js';
export type {
  FlightRecorderOptions,
  BatchOptions,
  ErrorInfo,
  ImpressionEvent,
  CustomEvent,
} from './flight-recorder.js';

// flushAt is a ceiling, not a target: the 10s timer does the routine
// flushing, so the buffer only reaches 10k under sustained load (>~1k
// events/s), where it caps memory at ~3.5 MB/batch over a normal fetch. A
// browser caller that bursts past ~180 events between flushes should override
// `batch` — a 10k keepalive flush on close() exceeds the 64 KB browser limit.
const DEFAULT_BATCH: BatchOptions = { flushAt: 10_000, flushAfterMs: 10_000 };

// Two retries — ky's own default. ky retries the POST on transient failures
// (network errors, 429, 5xx) with exponential backoff and honours Retry-After,
// so a brief blip doesn't drop a whole batch.
const DEFAULT_RETRY = { retries: 2 };

// Composition root: wires the production collaborators — the global fetch
// (present in Node >=20 and browsers) and a TimerScheduler over the real
// setTimeout — and sane default batching and retry policies, so callers don't
// repeat that boilerplate. Callers override `batch`/`retry` for other
// workloads; the scheduler and fetch are not configurable through this entry.
export const createFlightRecorder = (
  options: Omit<FlightRecorderOptions, 'scheduler' | 'fetch'>,
): FlightRecorder =>
  new FlightRecorder({
    batch: DEFAULT_BATCH,
    retry: DEFAULT_RETRY,
    ...options,
    fetch: globalThis.fetch,
    scheduler: new TimerScheduler(systemTimer),
  });
