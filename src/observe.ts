import { SpanBuilder } from './builder';
import { ConsoleExporter } from './exporters/console';

import type { Exporter, SpanRecord } from './span';

/**
 * The subset of the AVA instance the observer relies on: the public
 * EventEmitter subscribe/unsubscribe surface (supports the `*` wildcard).
 */
export interface AvaEventTarget {
  on(type: string, handler: (event: unknown) => void): void;
  off(type: string, handler: (event: unknown) => void): void;
}

export interface ObserveOptions {
  /** Where completed traces go. Defaults to ConsoleExporter. */
  exporter?: Exporter | Exporter[];
  /** Tagged onto each root span as `service.name`. */
  serviceName?: string;
  /** Fraction (0..1) of traces to keep. Defaults to 1 (keep all). */
  sampleRate?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface ObserveHandle {
  /** Unsubscribe, force-close open spans, and flush exporters. */
  stop(): Promise<void>;
}

function toArray(value: Exporter | Exporter[]): Exporter[] {
  return Array.isArray(value) ? value : [value];
}

function isEventObject(value: unknown): value is { type: unknown; data: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/**
 * Attach zero-intrusion tracing to an AVA instance.
 *
 * Subscribes to AVA's wildcard event stream and converts start/end event
 * pairs into a span tree. The observer never throws into AVA: any internal
 * failure is swallowed so analysis behavior is unchanged (invariant I4).
 */
export function observe(ava: AvaEventTarget, options: ObserveOptions = {}): ObserveHandle {
  const exporters = toArray(options.exporter ?? new ConsoleExporter());
  const sampleRate = options.sampleRate ?? 1;

  const builder = new SpanBuilder({
    now: options.now,
    onRootComplete: (root: SpanRecord) => {
      if (sampleRate < 1 && Math.random() >= sampleRate) return;
      if (options.serviceName) root.attributes['service.name'] = options.serviceName;
      for (const exporter of exporters) {
        try {
          exporter.exportSpan(root);
        } catch {
          /* observation must never break analysis */
        }
      }
    },
  });

  const handler = (event: unknown): void => {
    try {
      if (isEventObject(event)) builder.handle(event.type, event.data);
    } catch {
      /* swallow */
    }
  };

  ava.on('*', handler);

  return {
    async stop(): Promise<void> {
      try {
        ava.off('*', handler);
      } catch {
        /* ignore */
      }
      builder.flush();
      for (const exporter of exporters) {
        try {
          await exporter.flush?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
