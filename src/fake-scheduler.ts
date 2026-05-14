import type { Scheduler } from './scheduler.js';

export class FakeScheduler implements Scheduler {
    private intervals: Array<{ ms: number; handler: () => void }> = [];

    runEvery(ms: number, handler: () => void): void {
        this.intervals.push({ ms, handler });
    }

    advance(ms: number): void {
        for (const interval of this.intervals) {
            const times = Math.floor(ms / interval.ms);
            for (let i = 0; i < times; i++) interval.handler();
        }
    }
}
