import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SpanBuilder } from '../src/builder';
import { JsonExporter } from '../src/exporters/json';
import { parseEvent } from '../src/events';
import { fakeClock } from './helpers/fake-ava';
import real from './fixtures/real-ava-events.json';
import realAnalyze from './fixtures/real-ava-analyze.json';

/**
 * Contract test against the *installed* AVA package.
 *
 * The published bundle does not export its event enums (`exports` only maps
 * `.` and `./browser`), so we read the compiled constants straight from
 * node_modules. If AVA ever renames or adds an event we do not handle, this
 * test goes red instead of users silently getting empty traces.
 * Skipped when AVA is not installed (it is a peerDependency).
 */
const candidates = [
  join(process.cwd(), 'node_modules/@antv/ava/lib/event/constant.js'),
  join(process.cwd(), '../../node_modules/@antv/ava/lib/event/constant.js'),
];
const constantFile = candidates.find((path) => existsSync(path));

describe('contract against the installed @antv/ava', () => {
  it.skipIf(!constantFile)('handles every event name AVA defines', () => {
    const compiled = readFileSync(constantFile as string, 'utf8');
    const names = [...compiled.matchAll(/["']([a-z]+(?:start|end))["']/g)].map((match) => match[1]);

    expect(names.length).toBeGreaterThanOrEqual(20);
    expect(names.filter((name) => parseEvent(name) === null)).toEqual([]);
  });
});

/**
 * Golden replay of a stream recorded from a real AVA 4.0.0-beta.1 run
 * (`npm run verify`): csv load + profile + a failed analyze (unreachable LLM)
 * + a standalone dispose.
 */
describe('recorded real AVA stream', () => {
  const events = (real as { avaVersion: string; events: Array<{ type: string; data: unknown }> }).events;

  function replay() {
    const clock = fakeClock(1000, 10);
    const exporter = new JsonExporter();
    const builder = new SpanBuilder({ now: clock.now, onRootComplete: (root) => exporter.exportSpan(root) });
    for (const event of events) {
      builder.handle(event.type, event.data);
      clock.tick();
    }
    builder.flush();
    return exporter.spans;
  }

  it('rebuilds the real span tree with correct nesting and statuses', () => {
    const spans = replay();

    expect(spans.map((span) => span.name)).toEqual(['load', 'profile', 'analyze', 'dispose']);
    expect(spans.every((span) => span.endTime !== null)).toBe(true);

    const [load, profile, analyze, dispose] = spans;

    // Data loading: source type captured, engine lifecycle nested inside.
    expect(load.attributes['ava.sourceType']).toBe('csv');
    expect(load.children.map((child) => child.name)).toEqual(['create']);
    expect(load.status).toBe('ok');

    expect(profile.status).toBe('ok');

    // Failure path: analyze and its translate step both error, message kept.
    expect(analyze.status).toBe('error');
    expect(analyze.attributes['ava.query']).toBe('Compare income by region');
    const translate = analyze.children[0];
    expect(translate.name).toBe('translate');
    expect(translate.status).toBe('error');
    expect(translate.attributes['ava.attempt']).toBe(0);
    expect(translate.events[0].name).toBe('exception');
    expect(String(translate.events[0].attributes?.message)).toContain('Cannot connect to API');

    // A standalone dispose is a legitimate root, not an uncertain attribution.
    expect(dispose.status).toBe('ok');
    expect(dispose.attributes['ava.attribution']).toBeUndefined();
  });

  it('recognises every event name in the recorded stream', () => {
    expect(events.filter((event) => parseEvent(event.type) === null)).toEqual([]);
  });
});

/**
 * Golden replay of a real *successful* session (`npm run record`, DeepSeek via
 * `AVA_LLM_*` env): csv load, a `direct` analyze and a `loop` analyze.
 *
 * This is the strongest evidence the package works: the attributes asserted
 * below were produced by a real LLM and a real DuckDB engine, not by a mock.
 * It also pins down what the trace contributes beyond `AnalysisResponse`,
 * which already carries the final sql / data / text: per-step timing, the
 * translate `attempt`, and the `loop` reasoning sequence (step + action).
 */
describe('recorded real AVA analyze session', () => {
  const events = (realAnalyze as { events: Array<{ type: string; data: unknown }> }).events;

  function replay() {
    const clock = fakeClock(1000, 10);
    const exporter = new JsonExporter();
    const builder = new SpanBuilder({ now: clock.now, onRootComplete: (root) => exporter.exportSpan(root) });
    for (const event of events) {
      builder.handle(event.type, event.data);
      clock.tick();
    }
    builder.flush();
    return exporter.spans;
  }

  it('rebuilds the direct strategy tree and exposes the empty result', () => {
    const spans = replay();

    // The recording called handle.stop() before ava.dispose(), so the live
    // observer never saw the dispose pair; replaying the full stream does, and
    // it correctly becomes a standalone root.
    expect(spans.map((span) => span.name)).toEqual(['load', 'analyze', 'analyze', 'dispose']);
    expect(spans.every((span) => span.endTime !== null)).toBe(true);

    const [load, direct] = spans;
    expect(load.attributes['ava.sourceType']).toBe('csv');
    expect(load.children.map((child) => child.name)).toEqual(['create']);

    expect(direct.status).toBe('ok');
    expect(direct.attributes['ava.query']).toBe('Compare sales in January and February');
    expect(direct.children.map((child) => child.name)).toEqual(['translate', 'query', 'summarize']);

    const [translate, query, summarize] = direct.children;
    expect(translate.attributes['ava.attempt']).toBe(0);
    expect(String(translate.attributes['ava.dsl'])).toMatch(/SELECT month, SUM\(sales\)/);
    // The model wrote 'January' literals against 2025-01 data, so nothing matched.
    // `result.data.length` would show the empty result too; what only the trace
    // gives is *which* step produced that SQL, and on which attempt.
    expect(query.attributes['ava.rows']).toBe(0);
    expect(query.attributes['ava.rowCount']).toBe(0);
    expect(summarize.attributes['ava.summaryChars']).toBeGreaterThan(0);
    expect(direct.attributes['ava.attribution']).toBeUndefined();
  });

  it('rebuilds the loop strategy tree with reasoning steps and actions', () => {
    const loop = replay()[2];

    expect(loop.status).toBe('ok');
    expect(loop.attributes['ava.query']).toBe('What is the total sales across all months?');
    expect(loop.children.map((child) => child.name)).toEqual(['reason', 'query', 'reason']);

    const [firstReason, query, secondReason] = loop.children;
    // AVA emits the action with the `[...]` marker already stripped.
    expect(firstReason.attributes['ava.step']).toBe(0);
    expect(firstReason.attributes['ava.action']).toBe('SQL');
    expect(query.attributes['ava.dsl']).toBe('SELECT SUM(sales) AS total_sales FROM data;');
    expect(query.attributes['ava.rows']).toBe(1);
    expect(secondReason.attributes['ava.step']).toBe(1);
    expect(secondReason.attributes['ava.action']).toBe('CONFIRM');
  });

  it('recognises every event name in the recorded analyze stream', () => {
    expect(events.filter((event) => parseEvent(event.type) === null)).toEqual([]);
  });
});
