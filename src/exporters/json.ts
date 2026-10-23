import type { Exporter, SpanRecord } from '../span';

/**
 * Collects completed root spans in memory. Useful for tests, record-replay
 * fixtures, and as a base for file/HTTP exporters.
 */
export class JsonExporter implements Exporter {
  readonly spans: SpanRecord[] = [];

  exportSpan(span: SpanRecord): void {
    this.spans.push(span);
  }

  toJSON(): string {
    return JSON.stringify(this.spans, null, 2);
  }
}
