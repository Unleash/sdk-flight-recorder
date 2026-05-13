export type ImpressionEvent = {
  eventType: 'isEnabled' | 'getVariant';
  eventId: string;
  context: Record<string, unknown>;
  enabled: boolean;
  featureName: string;
  variant?: string;
  impressionData?: boolean;
};

export class FlightRecorder {
  record(_event: ImpressionEvent): void {}
}
