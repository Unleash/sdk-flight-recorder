import type { Scheduler, SchedulerStatus } from './scheduler.js';

export class FakeScheduler implements Scheduler {
    private interval: { ms: number; handler: () => Promise<void> } | undefined;
    private inFlight: Promise<void> | undefined;
    private status: SchedulerStatus = 'stopped';

    runEvery(ms: number, handler: () => Promise<void>): void {
        if (this.interval !== undefined) {
            throw new Error('FakeScheduler.runEvery called twice; only one interval is supported');
        }
        this.interval = { ms, handler };
        this.status = 'active';
    }

    async stop(): Promise<void> {
        this.status = 'stopped';
        if (this.inFlight !== undefined) {
            await this.inFlight;
        }
    }

    getStatus(): SchedulerStatus {
        return this.status;
    }

    async advance(ms: number): Promise<void> {
        if (this.interval === undefined) return;
        const times = Math.floor(ms / this.interval.ms);
        for (let i = 0; i < times; i++) {
            if (this.status === 'stopped') return;
            this.inFlight = this.interval.handler();
            await this.inFlight;
        }
    }
}
