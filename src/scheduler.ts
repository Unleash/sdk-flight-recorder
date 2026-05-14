export type Scheduler = {
    runEvery(ms: number, handler: () => void): void;
};
