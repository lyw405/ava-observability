import { describe, expect, it } from 'vitest';

import { SpanBuilder } from '../src/builder';
import { JsonExporter } from '../src/exporters/json';
import { fakeClock } from './helpers/fake-ava';
import fixture from './fixtures/direct-analyze.json';

/**
 * Record-replay accuracy baseline: a recorded real-world event stream is
 * replayed against a deterministic clock; the resulting span tree, durations,
 * and attributes must match exactly.
 */
describe('record-replay golden fixture', () => {
  it('rebuilds the exact span tree from a recorded event stream', () => {
    const clock = fakeClock(1000, 10);
    const exporter = new JsonExporter();
    const builder = new SpanBuilder({ now: clock.now, onRootComplete: (root) => exporter.exportSpan(root) });

    for (const event of fixture as { type: string; data: unknown }[]) {
      builder.handle(event.type, event.data);
      clock.tick();
    }

    expect(exporter.spans).toHaveLength(2);
    const [source, analyze] = exporter.spans;

    expect(source.name).toBe('source');
    expect(source.durationMs).toBe(30);
    expect(source.children.map((child) => child.name)).toEqual(['create']);
    expect(source.children[0].durationMs).toBe(10);

    expect(analyze.name).toBe('analyze');
    expect(analyze.durationMs).toBe(70);
    expect(analyze.attributes['ava.query']).toBe('Compare Jan and Feb sales');
    expect(analyze.children.map((child) => child.name)).toEqual(['translate', 'query', 'summarize']);
    expect(analyze.children[0].attributes['ava.dsl']).toBe(
      'SELECT month, SUM(sales) FROM sales GROUP BY month'
    );
    expect(analyze.children[1].attributes['ava.rows']).toBe(2);
    expect(analyze.children[2].attributes['ava.summaryChars']).toBe(
      'Sales fell from 38,897.18 to 21,804.11.'.length
    );
  });
});
