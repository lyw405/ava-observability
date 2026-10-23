/**
 * Span data model produced by the observer and consumed by exporters.
 * A completed root span carries its full child tree.
 */
export interface SpanEventRecord {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export type SpanStatus = 'ok' | 'error' | 'unfinished';

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** Human-readable span name, e.g. `analyze`, `translate`. */
  name: string;
  /** Raw AVA operation this span was derived from. */
  operation: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEventRecord[];
  children: SpanRecord[];
}

/**
 * Minimal sink for completed root spans. Implementations bridge to
 * OpenTelemetry, Langfuse, files, etc.
 */
export interface Exporter {
  exportSpan(span: SpanRecord): void;
  flush?: () => void | Promise<void>;
}
