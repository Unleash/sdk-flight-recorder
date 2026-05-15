import type { Scheduler, SchedulerStatus } from './scheduler.js';
import type { Timer } from './timer.js';

export class TimerScheduler implements Scheduler {
    private interval: { ms: number; handler: () => Promise<void> } | undefined;
    private cancel: (() => void) | undefined;
    private inFlight: Promise<void> | undefined;
    private status: SchedulerStatus = 'stopped';

    constructor(private readonly timer: Timer) {}

    runEvery(ms: number, handler: () => Promise<void>): void {
        if (this.interval !== undefined) {
            throw new Error('TimerScheduler.runEvery called twice; only one interval is supported');
        }
        this.interval = { ms, handler };
        this.status = 'active';
        this.scheduleNext();
    }

    async stop(): Promise<void> {
        this.cancel?.();
        this.cancel = undefined;
        this.status = 'stopped';
        if (this.inFlight !== undefined) {
            await this.inFlight;
        }
    }

    getStatus(): SchedulerStatus {
        return this.status;
    }

    private scheduleNext(): void {
        if (this.status === 'stopped' || this.interval === undefined) return;
        const { ms, handler } = this.interval;
        this.cancel = this.timer.schedule(ms, () => {
            this.cancel = undefined;
            this.inFlight = this.runTick(handler);
            return this.inFlight;
        });
    }

    private async runTick(handler: () => Promise<void>): Promise<void> {
        try {
            await handler();
        } finally {
            this.inFlight = undefined;
            this.scheduleNext();
        }
    }
}
