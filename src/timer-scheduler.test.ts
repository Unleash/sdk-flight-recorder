import { describe, expect, it } from 'vitest';
import { ControllableTimer } from './test-utils/controllable-timer.js';
import { createGate } from './test-utils/test-gate.js';
import { TimerScheduler } from './timer-scheduler.js';

describe('TimerScheduler', () => {
  it('runs the handler on every interval tick', async () => {
    const timer = new ControllableTimer();
    const scheduler = new TimerScheduler(timer);
    let calls = 0;
    scheduler.runEvery(100, async () => {
      calls++;
    });

    await timer.advance(300);

    expect(calls).toBe(3);
    await scheduler.stop();
  });

  it('throws when runEvery is called twice', () => {
    const scheduler = new TimerScheduler(new ControllableTimer());
    scheduler.runEvery(100, async () => {});
    expect(() => scheduler.runEvery(100, async () => {})).toThrow();
  });

  it('reports active after runEvery and stopped after stop', async () => {
    const scheduler = new TimerScheduler(new ControllableTimer());
    expect(scheduler.getStatus()).toBe('stopped');
    scheduler.runEvery(100, async () => {});
    expect(scheduler.getStatus()).toBe('active');
    await scheduler.stop();
    expect(scheduler.getStatus()).toBe('stopped');
  });

  it('does not run the handler after stop', async () => {
    const timer = new ControllableTimer();
    const scheduler = new TimerScheduler(timer);
    let calls = 0;
    scheduler.runEvery(100, async () => {
      calls++;
    });

    await scheduler.stop();
    await timer.advance(500);

    expect(calls).toBe(0);
  });

  it('stop awaits an in-flight handler before resolving', async () => {
    const timer = new ControllableTimer();
    const scheduler = new TimerScheduler(timer);
    const gate = createGate();
    const events: string[] = [];

    scheduler.runEvery(100, async () => {
      await gate.opened;
      events.push('handler finished');
    });

    const ticking = timer.advance(100);

    const stopped = scheduler.stop().then(() => events.push('stop resolved'));
    gate.open();
    await stopped;
    await ticking;

    expect(events).toEqual(['handler finished', 'stop resolved']);
  });
});
