/**
 * Real-AVA verification harness.
 *
 * Runs the actual published `@antv/ava` (duckdb engine, no API key needed for
 * source/schema/profile) and checks that our observer:
 *   1. recognises every event name AVA really emits (nothing silently ignored);
 *   2. builds a correct span tree from the real stream;
 *   3. captures real payloads (sourceType, error messages);
 *   4. captures the error path when the LLM is unreachable.
 *
 * The LLM baseURL points at a closed local port so `analyze` fails fast and
 * deterministically without any network call.
 *
 * Run: npx tsx scripts/verify-real-ava.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AVA } from '@antv/ava';

import { observe, JsonExporter } from '../src';
import { parseEvent } from '../src/events';

import type { SpanRecord } from '../src/span';

const CSV = 'region,income,employees\nEast,120000,45\nWest,98000,38\nNorth,143000,52\nSouth,87000,29\n';

/** Shrink payloads so the recorded fixture stays small and stable. */
function compact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = compact(v, depth + 1);
    return out;
  }
  return String(value);
}

function shape(span: SpanRecord, indent = ''): string[] {
  const attrs = Object.entries(span.attributes)
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? `${v.slice(0, 40)}…` : String(v)}`)
    .join(' ');
  const lines = [
    `${indent}${span.status === 'ok' ? '✓' : span.status === 'error' ? '✗' : '…'} ${span.name} (${span.durationMs}ms)${attrs ? `  ${attrs}` : ''}`,
  ];
  for (const child of span.children) lines.push(...shape(child, `${indent}  `));
  return lines;
}

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
}

async function main(): Promise<void> {
  const raw: Array<{ type: string; data: unknown }> = [];

  const ava = new AVA({
    llm: {
      model: 'gpt-4o-mini',
      apiKey: 'sk-invalid',
      baseURL: 'http://127.0.0.1:9/v1', // closed port → fast, offline failure
      maxRetries: 0,
    },
  });

  // Independent recorder: what AVA *actually* emits.
  ava.on('*', (event: unknown) => {
    const e = event as { type?: unknown; data?: unknown };
    raw.push({ type: String(e?.type), data: compact(e?.data) });
  });

  const json = new JsonExporter();
  const handle = observe(ava, { exporter: [json], serviceName: 'verify-real' });

  await ava.source({ type: 'csv', options: { csv: CSV } });
  await ava.schema();
  await ava.profile();

  try {
    await ava.analyze('Compare income by region');
    console.log('[unexpected] analyze succeeded without a reachable LLM');
  } catch (error) {
    console.log(`[expected] analyze failed: ${String((error as Error).message).slice(0, 100)}`);
  }

  // Standalone dispose: nested lifecycle events with no open root.
  await ava.dispose();
  await handle.stop();

  // ---- 1. every real event name must be recognised by our parser ----
  const unknown = raw.filter((r) => parseEvent(r.type) === null).map((r) => r.type);
  check('all real event names recognised', unknown.length === 0, unknown.join(','));

  const seen = [...new Set(raw.map((r) => r.type))];
  console.log(`\n=== real event names (${seen.length} unique, ${raw.length} emitted) ===`);
  console.log(seen.join(' '));

  // ---- 2. span tree shape ----
  console.log('\n=== span tree ===');
  for (const span of json.spans) for (const line of shape(span)) console.log(line);

  const byName = (name: string) => json.spans.filter((s) => s.name === name);
  // 4.0.0-beta.1 emits `load*`; current main renamed it to `source*`.
  const dataRoot = byName('load')[0] ?? byName('source')[0];
  const analyze = byName('analyze')[0];
  const emitsSchema = raw.some((r) => r.type === 'schemastart');

  check('data-load root captured (load|source)', !!dataRoot, dataRoot?.name ?? 'missing');
  check('data-load has create child', !!dataRoot?.children.some((c) => c.name === 'create'));
  check('data-load records ava.sourceType=csv', dataRoot?.attributes['ava.sourceType'] === 'csv');
  if (emitsSchema) check('schema root captured ok', byName('schema')[0]?.status === 'ok');
  else console.log('(note: this AVA version emits no schema events — check skipped)');
  check('profile root captured ok', byName('profile')[0]?.status === 'ok');
  check('analyze root captured', !!analyze);
  check('analyze records ava.query', typeof analyze?.attributes['ava.query'] === 'string');
  check('analyze status=error (LLM unreachable)', analyze?.status === 'error');
  check(
    'translate child status=error with exception',
    analyze?.children.some((c) => c.name === 'translate' && c.status === 'error' && c.events.length > 0) === true
  );
  check('service.name tagged', json.spans.every((s) => s.attributes['service.name'] === 'verify-real'));

  // ---- 3. structural invariants on the real tree ----
  let structural = true;
  const walk = (span: SpanRecord): void => {
    if (span.endTime === null) structural = false;
    for (const child of span.children) {
      if (child.startTime < span.startTime) structural = false;
      if (child.endTime === null || (child.endTime as number) > (span.endTime as number)) structural = false;
      if (child.traceId !== span.traceId) structural = false;
      walk(child);
    }
    for (let i = 1; i < span.children.length; i++) {
      if (span.children[i].startTime < span.children[i - 1].startTime) structural = false;
    }
  };
  for (const span of json.spans) walk(span);
  check('structural invariants hold on real stream', structural);

  // ---- 4. record the fixture ----
  const fixturePath = join(__dirname, '..', '__tests__', 'fixtures', 'real-ava-events.json');
  writeFileSync(fixturePath, `${JSON.stringify({ avaVersion: '4.0.0-beta.1', events: raw }, null, 2)}\n`);
  console.log(`\nfixture written: ${fixturePath}`);

  console.log('\n=== checks ===');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
