import { describe, expect, it } from 'vitest';

import { SpanBuilder } from '../src/builder';
import { JsonExporter } from '../src/exporters/json';
import { FakeAVA, fakeClock } from './helpers/fake-ava';

function collect(clockStep = 10): { ava: FakeAVA; exporter: JsonExporter; tick: () => number } {
  const clock = fakeClock(1000, clockStep);
  const ava = new FakeAVA();
  const exporter = new JsonExporter();
  const builder = new SpanBuilder({ now: clock.now, onRootComplete: (root) => exporter.exportSpan(root) });
  // Wire the wildcard subscription the same way observe() does.
  ava.on('*', (event) => {
    const { type, data } = event as { type: unknown; data: unknown };
    builder.handle(type, data);
  });
  return { ava, exporter, tick: clock.tick };
}

describe('SpanBuilder tree construction', () => {
  it('nests analysis steps under the analyze root and captures attributes', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('analyzestart', { query: 'Compare Jan and Feb sales' });
    tick();
    ava.emit('translatestart', { query: 'Compare Jan and Feb sales', attempt: 0 });
    tick();
    ava.emit('translateend', { dsl: 'SELECT month, SUM(sales) FROM sales GROUP BY month' });
    tick();
    ava.emit('querystart', { dsl: 'SELECT month, SUM(sales) FROM sales GROUP BY month' });
    tick();
    ava.emit('queryend', { schema: [], data: [{ month: '2025-01' }, { month: '2025-02' }], rowCount: 2 });
    tick();
    ava.emit('summarizestart', {});
    tick();
    ava.emit('summarizeend', { text: 'Sales fell.' });
    tick();
    ava.emit('analyzeend', {});

    expect(exporter.spans).toHaveLength(1);
    const root = exporter.spans[0];
    expect(root.name).toBe('analyze');
    expect(root.parentSpanId).toBeNull();
    expect(root.attributes['ava.query']).toBe('Compare Jan and Feb sales');
    expect(root.durationMs).toBe(70);
    expect(root.status).toBe('ok');

    const childNames = root.children.map((child) => child.name);
    expect(childNames).toEqual(['translate', 'query', 'summarize']);

    const [translate, query, summarize] = root.children;
    expect(translate.attributes['ava.dsl']).toBe('SELECT month, SUM(sales) FROM sales GROUP BY month');
    expect(translate.parentSpanId).toBe(root.spanId);
    expect(translate.traceId).toBe(root.traceId);
    expect(query.attributes['ava.rows']).toBe(2);
    expect(query.attributes['ava.rowCount']).toBe(2);
    expect(summarize.attributes['ava.summaryChars']).toBe('Sales fell.'.length);
  });

  it('keeps engine lifecycle (create) nested inside source', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('sourcestart', { type: 'csv-file' });
    tick();
    ava.emit('createstart', {});
    tick();
    ava.emit('createend', {});
    tick();
    ava.emit('sourceend', {});

    expect(exporter.spans).toHaveLength(1);
    const root = exporter.spans[0];
    expect(root.name).toBe('source');
    expect(root.attributes['ava.sourceType']).toBe('csv-file');
    expect(root.children.map((child) => child.name)).toEqual(['create']);
  });

  it('supports repeated query/reason children from the loop strategy', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('analyzestart', { query: 'q' });
    tick();
    ava.emit('reasonstart', { step: 1 });
    tick();
    // Real AVA strips the `[ACTION]` marker: reasonend carries `action: 'SQL'`.
    ava.emit('reasonend', { step: 1, action: 'SQL' });
    tick();
    ava.emit('querystart', { dsl: 'SELECT 1' });
    tick();
    ava.emit('queryend', { data: [] });
    tick();
    ava.emit('reasonstart', { step: 2 });
    tick();
    ava.emit('reasonend', { step: 2, action: 'CONFIRM' });
    tick();
    ava.emit('queryend', { data: [] }); // stray duplicate end is ignored
    ava.emit('analyzeend', {});

    const root = exporter.spans[0];
    expect(root.children.map((child) => child.name)).toEqual(['reason', 'query', 'reason']);
    expect(root.children[1].attributes['ava.action']).toBeUndefined();
    expect(root.children[0].attributes['ava.action']).toBe('SQL');
  });
});

describe('SpanBuilder fidelity against real AVA behaviour', () => {
  it('nests translate/query/summarize inside selectcontext (subset strategy)', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('analyzestart', { query: 'q' });
    tick();
    ava.emit('selectcontextstart', {});
    tick();
    ava.emit('translatestart', { query: 'q', attempt: 0 });
    tick();
    ava.emit('translateend', { dsl: 'SELECT 1' });
    tick();
    ava.emit('querystart', { dsl: 'SELECT 1' });
    tick();
    ava.emit('queryend', { data: [{ a: 1 }] });
    tick();
    ava.emit('summarizestart', {});
    tick();
    ava.emit('summarizeend', { text: 'ok' });
    tick();
    ava.emit('selectcontextend', {});
    tick();
    ava.emit('analyzeend', {});

    const root = exporter.spans[0];
    expect(root.children.map((child) => child.name)).toEqual(['selectcontext']);
    const context = root.children[0];
    expect(context.children.map((child) => child.name)).toEqual(['translate', 'query', 'summarize']);
    expect(context.children[0].attributes['ava.attempt']).toBe(0);
    expect(context.children[1].attributes['ava.rows']).toBe(1);
  });

  it('treats a standalone dispose as a plain root, not uncertain attribution', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('disposestart', {});
    tick();
    ava.emit('disposeend', {});

    expect(exporter.spans).toHaveLength(1);
    const root = exporter.spans[0];
    expect(root.name).toBe('dispose');
    expect(root.parentSpanId).toBeNull();
    expect(root.status).toBe('ok');
    expect(root.attributes['ava.attribution']).toBeUndefined();
  });

  it('still flags an orphaned analysis step as uncertain', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('translatestart', { query: 'q' });
    tick();
    ava.emit('translateend', { dsl: 'SELECT 1' });

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0].attributes['ava.attribution']).toBe('uncertain');
  });

  it('captures loop step numbers and the visualize query', () => {
    const { ava, exporter, tick } = collect();

    ava.emit('analyzestart', { query: 'q' });
    tick();
    ava.emit('reasonstart', { step: 2 });
    tick();
    ava.emit('reasonend', { step: 2, action: 'SQL', text: 't' });
    tick();
    ava.emit('analyzeend', {});
    tick();
    ava.emit('visualizestart', { query: 'q' });
    tick();
    ava.emit('visualizeend', {});

    const analyze = exporter.spans[0];
    expect(analyze.children[0].attributes['ava.step']).toBe(2);
    expect(analyze.children[0].attributes['ava.action']).toBe('SQL');

    const visualize = exporter.spans[1];
    expect(visualize.name).toBe('visualize');
    expect(visualize.attributes['ava.query']).toBe('q');
  });
});
