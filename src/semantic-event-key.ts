import type { CustomEvent, ImpressionEvent } from './flight-recorder.js';

// Dedup key: two events are duplicates when identical except for their
// timestamp. Built from the identifying fields directly — no JSON.stringify
// replacer (a function replacer disables V8's fast-path serializer and is
// invoked once per property of the whole object graph). Only context/payload
// are JSON-serialized. Segments are joined with U+001F (unit separator):
// JSON.stringify escapes it rather than emitting it raw, so the serialized
// segments cannot bleed across boundaries.
const SEP = String.fromCharCode(0x1f);

export const semanticEventKey = (event: ImpressionEvent | CustomEvent): string => {
  if (event.eventType === 'custom') {
    return [
      'custom',
      event.eventName,
      JSON.stringify(event.context),
      event.payload === undefined ? '' : JSON.stringify(event.payload),
    ].join(SEP);
  }
  return [
    event.eventType,
    event.featureName,
    event.variant ?? '',
    event.enabled ? '1' : '0',
    JSON.stringify(event.context),
  ].join(SEP);
};
