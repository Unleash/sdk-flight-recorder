import type { Scheduler, SchedulerStatus } from './scheduler.js';

type Interval = { ms: number; handler: () => Promise<void>; status: SchedulerStatus };

export class FakeScheduler implements Scheduler {
    private interval: Interval | undefined;

    runEvery(ms: number, handler: () => Promise<void>): void {
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

    async advance(ms: number): Promise<void> {
        if (this.interval === undefined) return;
        const times = Math.floor(ms / this.interval.ms);
        for (let i = 0; i < times; i++) {
            if (this.interval.status === 'stopped') return;
            await this.interval.handler();
        }
    }
}
