export type SchedulerStatus = 'active' | 'stopped';

export type Scheduler = {
    runEvery(ms: number, handler: () => Promise<void>): void;
    stop(): void;
    getStatus(): SchedulerStatus;
};
