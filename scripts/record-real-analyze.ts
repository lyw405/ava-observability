/**
 * Records a REAL successful analysis session against the published @antv/ava
 * and stores it as a golden fixture for replay tests.
 *
 * Credentials are read from the environment only — never hardcode them:
 *   AVA_LLM_API_KEY   (required)
 *   AVA_LLM_BASE_URL  (default https://api.deepseek.com/v1)
 *   AVA_LLM_MODEL     (default deepseek-chat)
 *
 * Run:
 *   AVA_LLM_API_KEY=... npm run record
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AVA } from '@antv/ava';

import { observe, JsonExporter } from '../src';
import { parseEvent } from '../src/events';

import type { SpanRecord } from '../src/span';

const CSV = 'month,region,sales\n2025-01,East,1200\n2025-02,East,980\n2025-03,East,1430\n2025-01,West,760\n2025-02,West,1105\n';

/** Keep small arrays/strings verbatim so the fixture replays faithfully. */
function compact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) {
    return value.length <= 5 ? value.map((item) => compact(item, depth + 1)) : `[array:${value.length}]`;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = compact(v, depth + 1);
    return out;
  }
  return String(value);
}

function shape(span: SpanRecord, indent = ''): string[] {
  const attrs = Object.entries(span.attributes)
    .filter(([k]) => k !== 'ava.operation' && k !== 'service.name')
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}…` : String(v)}`)
    .join(' ');
  const mark = span.status === 'ok' ? '✓' : span.status === 'error' ? '✗' : '…';
  const lines = [`${indent}${mark} ${span.name} (${span.durationMs}ms)${attrs ? `  ${attrs}` : ''}`];
  for (const child of span.children) lines.push(...shape(child, `${indent}  `));
  return lines;
}

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail]);
}

async function main(): Promise<void> {
  const apiKey = process.env.AVA_LLM_API_KEY;
  if (!apiKey) {
    console.error('AVA_LLM_API_KEY is required (read from env only; never hardcode it).');
    process.exit(2);
  }
  const baseURL = process.env.AVA_LLM_BASE_URL ?? 'https://api.deepseek.com/v1';
  const model = process.env.AVA_LLM_MODEL ?? 'deepseek-chat';

  const raw: Array<{ type: string; data: unknown }> = [];
  const ava = new AVA({ llm: { model, apiKey, baseURL, maxRetries: 1 } });

  ava.on('*', (event: unknown) => {
    const e = event as { type?: unknown; data?: unknown };
    raw.push({ type: String(e?.type), data: compact(e?.data) });
  });

  const json = new JsonExporter();
  const handle = observe(ava, { exporter: json, serviceName: 'record-real' });

  await ava.source({ type: 'csv', options: { csv: CSV } });

  console.log('\n--- direct strategy ---');
  const direct = await ava.analyze('Compare sales in January and February', { strategy: { type: 'direct' } });
  console.log(`sql: ${direct.sql ?? '(none)'}`);
  console.log(`rows: ${direct.data.length}  text: ${direct.text.slice(0, 120)}`);

  console.log('\n--- loop strategy ---');
  const loop = await ava.analyze('What is the total sales across all months?', {
    strategy: { type: 'loop', maxSteps: 3 },
  });
  console.log(`rows: ${loop.data.length}  text: ${loop.text.slice(0, 120)}`);

  await handle.stop();
  await ava.dispose();

  console.log('\n=== span tree ===');
  for (const span of json.spans) for (const line of shape(span)) console.log(line);

  // ---- checks ----
  const unknown = raw.filter((r) => parseEvent(r.type) === null).map((r) => r.type);
  check('all real event names recognised', unknown.length === 0, unknown.join(','));

  const analyzes = json.spans.filter((s) => s.name === 'analyze');
  check('two analyze roots captured', analyzes.length === 2, String(analyzes.length));

  const [directSpan, loopSpan] = analyzes;
  const child = (span: SpanRecord | undefined, name: string) => span?.children.find((c) => c.name === name);

  check('direct analyze status=ok', directSpan?.status === 'ok', String(directSpan?.status));
  check(
    'direct children = translate,query,summarize',
    JSON.stringify(directSpan?.children.map((c) => c.name)) === JSON.stringify(['translate', 'query', 'summarize']),
    JSON.stringify(directSpan?.children.map((c) => c.name))
  );
  const dsl = child(directSpan, 'translate')?.attributes['ava.dsl'];
  check('translate captured real SQL', typeof dsl === 'string' && /select/i.test(dsl), String(dsl).slice(0, 80));
  const rows = child(directSpan, 'query')?.attributes['ava.rows'];
  // 0 is a legitimate observation: the generated SQL matched nothing. The point
  // of asserting it is fidelity of the count, not that the trace uniquely
  // reveals emptiness (`result.data.length` does that too).
  check('query captured real row count', typeof rows === 'number' && rows >= 0, String(rows));

  // These are the attributes AnalysisResponse genuinely cannot provide.
  check(
    'translate captured the retry round',
    typeof child(directSpan, 'translate')?.attributes['ava.attempt'] === 'number',
    String(child(directSpan, 'translate')?.attributes['ava.attempt'])
  );
  check(
    'every direct step has a real duration',
    (directSpan?.children ?? []).every((c) => typeof c.durationMs === 'number' && c.durationMs >= 0),
    (directSpan?.children ?? []).map((c) => `${c.name}:${c.durationMs}`).join(',')
  );
  const summaryChars = child(directSpan, 'summarize')?.attributes['ava.summaryChars'];
  check('summarize captured summary size', typeof summaryChars === 'number' && summaryChars > 0, String(summaryChars));

  check('loop analyze status=ok', loopSpan?.status === 'ok', String(loopSpan?.status));
  const reasons = loopSpan?.children.filter((c) => c.name === 'reason') ?? [];
  check('loop produced reason spans', reasons.length > 0, String(reasons.length));
  check(
    'loop reason spans carry action/step',
    reasons.some((r) => typeof r.attributes['ava.action'] === 'string') &&
      reasons.some((r) => typeof r.attributes['ava.step'] === 'number')
  );
  check('loop ran real queries', (loopSpan?.children.filter((c) => c.name === 'query') ?? []).length > 0);

  let structural = true;
  const walk = (span: SpanRecord): void => {
    if (span.endTime === null) structural = false;
    for (const c of span.children) {
      if (c.startTime < span.startTime || c.endTime === null || (c.endTime as number) > (span.endTime as number)) {
        structural = false;
      }
      if (c.traceId !== span.traceId || c.parentSpanId !== span.spanId) structural = false;
      walk(c);
    }
    for (let i = 1; i < span.children.length; i++) {
      if (span.children[i].startTime < span.children[i - 1].startTime) structural = false;
    }
  };
  for (const span of json.spans) walk(span);
  check('structural invariants hold on real stream', structural);

  // ---- fixture ----
  const fixturePath = join(__dirname, '..', '__tests__', 'fixtures', 'real-ava-analyze.json');
  writeFileSync(
    fixturePath,
    `${JSON.stringify({ avaVersion: '4.0.0-beta.1', model, strategy: ['direct', 'loop'], events: raw }, null, 2)}\n`
  );
  console.log(`\nfixture written: ${fixturePath} (${raw.length} events)`);

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
