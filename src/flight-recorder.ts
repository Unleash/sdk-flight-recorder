import { toNdjson } from './ndjson.js';

export type ImpressionEvent = {
  eventType: 'isEnabled' | 'getVariant';
  eventId: string;
  context: Record<string, unknown>;
  enabled: boolean;
  featureName: string;
  variant?: string;
  impressionData?: boolean;
};

export type CustomEvent = {
  eventType: 'custom';
  eventId: string;
  context: Record<string, unknown>;
  name: string;
  payload?: unknown;
};

export type FlightRecorderOptions = {
  url: string;
  fetch?: typeof fetch;
};

export class FlightRecorder {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private readonly buffer: Array<ImpressionEvent | CustomEvent> = [];

  constructor(options: FlightRecorderOptions) {
    this.url = options.url;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  record(event: ImpressionEvent | CustomEvent): void {
    this.buffer.push(event);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const toSend = this.buffer.splice(0);
    const body = toNdjson(toSend);
    await this.fetch(this.url, { method: 'POST', body });
  }
}
