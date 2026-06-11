import { describe, expect, it } from 'vitest';
import type { AdminEvent, CustomEvent, ImpressionEvent } from './flight-recorder.js';
import { semanticEventKey } from './semantic-event-key.js';

const defaultImpression: ImpressionEvent = {
  eventType: 'isEnabled',
  context: {},
  enabled: true,
  featureName: 'demo.flag',
};

const makeImpression = (overrides: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
  ...defaultImpression,
  ...overrides,
});

const defaultCustom: CustomEvent = {
  eventType: 'custom',
  context: {},
  eventName: 'signup',
};

const makeCustom = (overrides: Partial<CustomEvent> = {}): CustomEvent => ({
  ...defaultCustom,
  ...overrides,
});

const defaultAdmin: AdminEvent = {
  eventType: 'admin',
  context: {},
  eventName: 'user-created',
};

const makeAdmin = (overrides: Partial<AdminEvent> = {}): AdminEvent => ({
  ...defaultAdmin,
  ...overrides,
});

describe('semanticEventKey', () => {
  it('treats two evaluations of the same flag as duplicates', () => {
    expect(semanticEventKey(makeImpression())).toBe(semanticEventKey(makeImpression()));
  });

  it('distinguishes evaluations of different variants of the same flag', () => {
    const variantA = makeImpression({ eventType: 'getVariant', variant: 'A' });
    const variantB = makeImpression({ eventType: 'getVariant', variant: 'B' });

    expect(semanticEventKey(variantA)).not.toBe(semanticEventKey(variantB));
  });

  it('distinguishes an enabled evaluation from a disabled one', () => {
    const enabled = makeImpression({ enabled: true });
    const disabled = makeImpression({ enabled: false });

    expect(semanticEventKey(enabled)).not.toBe(semanticEventKey(disabled));
  });

  it('distinguishes evaluations made under different context', () => {
    const userOne = makeImpression({ context: { userId: 'user-1' } });
    const userTwo = makeImpression({ context: { userId: 'user-2' } });

    expect(semanticEventKey(userOne)).not.toBe(semanticEventKey(userTwo));
  });

  it('distinguishes evaluations of different flags', () => {
    const flagOne = makeImpression({ featureName: 'flag-one' });
    const flagTwo = makeImpression({ featureName: 'flag-two' });

    expect(semanticEventKey(flagOne)).not.toBe(semanticEventKey(flagTwo));
  });

  it('distinguishes isEnabled evaluations from getVariant evaluations', () => {
    const isEnabled = makeImpression({ eventType: 'isEnabled' });
    const getVariant = makeImpression({ eventType: 'getVariant' });

    expect(semanticEventKey(isEnabled)).not.toBe(semanticEventKey(getVariant));
  });

  it('treats two identical custom events as duplicates', () => {
    expect(semanticEventKey(makeCustom())).toBe(semanticEventKey(makeCustom()));
  });

  it('distinguishes custom events with different names', () => {
    const signup = makeCustom({ eventName: 'signup' });
    const purchase = makeCustom({ eventName: 'purchase' });

    expect(semanticEventKey(signup)).not.toBe(semanticEventKey(purchase));
  });

  it('distinguishes custom events with different payloads', () => {
    const proPlan = makeCustom({ payload: { plan: 'pro' } });
    const freePlan = makeCustom({ payload: { plan: 'free' } });

    expect(semanticEventKey(proPlan)).not.toBe(semanticEventKey(freePlan));
  });

  it('distinguishes custom events made under different context', () => {
    const userOne = makeCustom({ context: { userId: 'user-1' } });
    const userTwo = makeCustom({ context: { userId: 'user-2' } });

    expect(semanticEventKey(userOne)).not.toBe(semanticEventKey(userTwo));
  });

  it('distinguishes admin events with different names', () => {
    const userCreated = makeAdmin({ eventName: 'user-created' });
    const userDeleted = makeAdmin({ eventName: 'user-deleted' });

    expect(semanticEventKey(userCreated)).not.toBe(semanticEventKey(userDeleted));
  });

  it('never collides an admin event with a custom event of the same name', () => {
    const custom = makeCustom({ eventName: 'user-created' });
    const admin = makeAdmin({ eventName: 'user-created' });

    expect(semanticEventKey(admin)).not.toBe(semanticEventKey(custom));
  });

  it('never collides an impression with a custom event', () => {
    const impression = makeImpression();
    const custom = makeCustom();

    expect(semanticEventKey(impression)).not.toBe(semanticEventKey(custom));
  });
});
