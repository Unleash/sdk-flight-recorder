import type { Scheduler, SchedulerStatus } from './scheduler.js';

type Interval = { ms: number; handler: () => void; status: SchedulerStatus };

export class FakeScheduler implements Scheduler {
    private interval: Interval | undefined;

    runEvery(ms: number, handler: () => void): void {
        if (this.interval !== undefined) {
            throw new Error('FakeScheduler.runEvery called twice; only one interval is supported');
        }
        this.interval = { ms, handler, status: 'active' };
    }

    stop(): void {
        if (this.interval !== undefined) {
            this.interval.status = 'stopped';
        }
    }

    getStatus(): SchedulerStatus {
        return this.interval?.status ?? 'stopped';
    }

    advance(ms: number): void {
        if (this.interval === undefined || this.interval.status === 'stopped') return;
        const times = Math.floor(ms / this.interval.ms);
        for (let i = 0; i < times; i++) this.interval.handler();
    }
}
