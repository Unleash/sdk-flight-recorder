export type SchedulerStatus = 'active' | 'stopped';

export type Scheduler = {
    runEvery(ms: number, handler: () => void): void;
    stop(): void;
    getStatus(): SchedulerStatus;
};
