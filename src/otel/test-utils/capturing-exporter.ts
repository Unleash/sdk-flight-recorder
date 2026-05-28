import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

// Like @opentelemetry/sdk-logs' InMemoryLogRecordExporter but its `shutdown()`
// does not reset the captured records, so assertions after a recorder's
// `close()` still see what was exported.
export class CapturingExporter implements LogRecordExporter {
  readonly captured: ReadableLogRecord[] = [];

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.captured.push(...logs);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
