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

export class FlightRecorder {
  record(_event: ImpressionEvent | CustomEvent): void {}

  async flush(): Promise<void> {}
}
