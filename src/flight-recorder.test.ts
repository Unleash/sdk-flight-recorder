import { describe, it, expect } from 'vitest';
import { FlightRecorder } from './flight-recorder.js';

describe('FlightRecorder', () => {
  it('can be instantiated', () => {
    const recorder = new FlightRecorder();
    expect(recorder).toBeInstanceOf(FlightRecorder);
  });
});
