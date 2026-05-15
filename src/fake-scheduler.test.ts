import { describe, it, expect } from 'vitest';
import { FakeScheduler } from './fake-scheduler.js';

const createGate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, opened };
};

describe('FakeScheduler', () => {
    it('runs the handler once per interval inside advance', async () => {
        let calls = 0;
        const scheduler = new FakeScheduler();
        scheduler.runEvery(100, async () => {
            calls++;
        });

        await scheduler.advance(350);

        expect(calls).toBe(3);
    });

    it('throws when runEvery is called twice', () => {
        const scheduler = new FakeScheduler();
        scheduler.runEvery(100, async () => {});
        expect(() => scheduler.runEvery(100, async () => {})).toThrow();
    });

    it('reports active after runEvery and stopped after stop', async () => {
        const scheduler = new FakeScheduler();
        expect(scheduler.getStatus()).toBe('stopped');
        scheduler.runEvery(100, async () => {});
        expect(scheduler.getStatus()).toBe('active');
        await scheduler.stop();
        expect(scheduler.getStatus()).toBe('stopped');
    });

    it('does not invoke the handler after stop', async () => {
        let calls = 0;
        const scheduler = new FakeScheduler();
        scheduler.runEvery(100, async () => {
            calls++;
        });

        await scheduler.stop();
        await scheduler.advance(500);

        expect(calls).toBe(0);
    });

    it('stop awaits an in-flight handler before resolving', async () => {
        const gate = createGate();
        const events: string[] = [];

        const scheduler = new FakeScheduler();
        scheduler.runEvery(100, async () => {
            await gate.opened;
            events.push('handler finished');
        });

        void scheduler.advance(100);
        const stopped = scheduler.stop().then(() => events.push('stop resolved'));

        gate.open();
        await stopped;

        expect(events).toEqual(['handler finished', 'stop resolved']);
    });
});
