import { describe, expect, it } from 'vitest';

import { observe } from '../src/observe';
import { JsonExporter } from '../src/exporters/json';
import { FakeAVA, sleep } from './helpers/fake-ava';

import type { SpanRecord } from '../src/span';

/**
 * I2 (structural, always guaranteed): every child interval sits inside its
 * parent, links are consistent, and siblings are ordered by start time.
 *
 * Siblings may legitimately OVERLAP: concurrent work on one instance and
 * adversarial/interleaved event streams produce overlapping spans. Overlap is
 * therefore not a structural violation (roots that overlap are flagged
 * `ava.attribution=uncertain` per I3).
 */
function assertStructuralInvariants(span: SpanRecord): void {
  for (const child of span.children) {
    expect(child.startTime).toBeGreaterThanOrEqual(span.startTime);
    expect(child.endTime).not.toBeNull();
    expect(child.endTime as number).toBeLessThanOrEqual(span.endTime as number);
    expect(child.traceId).toBe(span.traceId);
    expect(child.parentSpanId).toBe(span.spanId);
    assertStructuralInvariants(child);
  }
  for (let i = 1; i < span.children.length; i++) {
    expect(span.children[i].startTime).toBeGreaterThanOrEqual(span.children[i - 1].startTime);
  }
}

/**
 * Strict variant for genuinely sequential streams (no concurrent operations):
 * additionally asserts siblings do not overlap.
 */
function assertSequentialInvariants(span: SpanRecord): void {
  assertStructuralInvariants(span);
  for (let i = 1; i < span.children.length; i++) {
    expect(span.children[i].startTime).toBeGreaterThanOrEqual(span.children[i - 1].endTime as number);
  }
}

describe('accuracy: differential cross-check against independent wall clock', () => {
  it('span durations match independently measured wall time', async () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    observe(ava, { exporter }); // real clock

    const wallStart = Date.now();
    ava.emit('analyzestart', { query: 'q' });
    await sleep(25);
    ava.emit('translatestart', {});
    await sleep(15);
    ava.emit('translateend', { dsl: 'SELECT 1' });
    ava.emit('analyzeend', {});
    const wall = Date.now() - wallStart;

    const root = exporter.spans[0];
    // Tolerance absorbs timer granularity / scheduling jitter.
    expect(root.durationMs).toBeGreaterThanOrEqual(wall - 5);
    expect(root.durationMs).toBeLessThanOrEqual(wall + 60);

    const translate = root.children[0];
    expect(translate.durationMs).toBeGreaterThanOrEqual(15 - 5);
    expect(translate.durationMs).toBeLessThanOrEqual(15 + 60);
    assertSequentialInvariants(root);
  });
});

describe('accuracy: error paths close spans with error status', () => {
  it('marks failing translate and analyze as error with exception event', () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    const handle = observe(ava, { exporter });

    ava.emit('analyzestart', { query: 'q' });
    ava.emit('translatestart', {});
    ava.emit('translateend', { error: { message: 'model unavailable' } });
    ava.emit('analyzeend', { error: { message: 'model unavailable' } });

    const root = exporter.spans[0];
    expect(root.status).toBe('error');
    const translate = root.children[0];
    expect(translate.status).toBe('error');
    expect(translate.events[0].name).toBe('exception');
    expect(translate.events[0].attributes?.message).toBe('model unavailable');
    assertSequentialInvariants(root);
    return handle.stop();
  });
});

describe('accuracy: I1 no dangling spans', () => {
  it('force-closes abandoned spans as unfinished on stop()', async () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    const handle = observe(ava, { exporter });

    ava.emit('analyzestart', { query: 'q' });
    ava.emit('translatestart', {});
    // No end events at all (e.g. process died mid-analysis).
    await handle.stop();

    expect(exporter.spans).toHaveLength(1);
    const root = exporter.spans[0];
    expect(root.status).toBe('unfinished');
    expect(root.endTime).not.toBeNull();
    expect(root.children).toHaveLength(1);
    expect(root.children[0].status).toBe('unfinished');
  });
});

describe('accuracy: I3 uncertain attribution instead of silent mis-parenting', () => {
  it('flags overlapping roots on one instance', () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    observe(ava, { exporter });

    ava.emit('analyzestart', { query: 'a' });
    ava.emit('analyzestart', { query: 'b' }); // concurrent on same instance
    ava.emit('analyzeend', {});
    ava.emit('analyzeend', {});

    expect(exporter.spans).toHaveLength(2);
    for (const root of exporter.spans) {
      expect(root.attributes['ava.attribution']).toBe('uncertain');
    }
  });

  it('flags a stray nested event with no open root', () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    observe(ava, { exporter });

    ava.emit('translatestart', {});
    ava.emit('translateend', { dsl: 'SELECT 1' });

    const root = exporter.spans[0];
    expect(root.name).toBe('translate');
    expect(root.attributes['ava.attribution']).toBe('uncertain');
  });
});

describe('accuracy: I4 observer never breaks the analysis', () => {
  it('swallows exporter failures so emit does not throw', () => {
    const ava = new FakeAVA();
    const throwing = { exportSpan: (): void => { throw new Error('exporter down'); } };
    observe(ava, { exporter: throwing });

    expect(() => {
      ava.emit('analyzestart', { query: 'q' });
      ava.emit('analyzeend', {});
    }).not.toThrow();
  });

  it('ignores unknown / malformed events', () => {
    const ava = new FakeAVA();
    const exporter = new JsonExporter();
    observe(ava, { exporter });

    expect(() => {
      ava.emit('bogusevent', {});
      ava.emit('analyzestart', { query: 'q' });
      ava.emit('analyzeend', {});
    }).not.toThrow();
    expect(exporter.spans).toHaveLength(1);
  });
});

describe('accuracy: fuzz / invariant sweep', () => {
  it('never crashes, never leaks open spans under random event streams', async () => {
    const ops = ['source', 'analyze', 'translate', 'query', 'summarize', 'reason', 'create'];
    const phases = ['start', 'end'];

    for (let seed = 0; seed < 60; seed++) {
      const ava = new FakeAVA();
      const exporter = new JsonExporter();
      const handle = observe(ava, { exporter });

      // Deterministic pseudo-random stream (includes unmatched ends/dups).
      let state = seed + 1;
      const rand = (): number => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };

      for (let i = 0; i < 40; i++) {
        const op = ops[Math.floor(rand() * ops.length)];
        const phase = phases[Math.floor(rand() * phases.length)];
        ava.emit(`${op}${phase}`, rand() > 0.9 ? { error: { message: 'x' } } : { dsl: 'SELECT 1', data: [] });
      }
      await handle.stop(); // must force-close everything

      for (const root of exporter.spans) {
        expect(root.endTime).not.toBeNull();
        // Fuzz emits arbitrary interleavings, so siblings may overlap by design:
        // assert only the structural guarantees.
        assertStructuralInvariants(root);
      }
    }
  });
});
