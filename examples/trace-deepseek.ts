/**
 * Real-AVA example wired to DeepSeek (OpenAI-compatible API).
 *
 * Attaches the observer, runs one `direct` and one `loop` analysis against a
 * live model, prints the terminal waterfall, then shows what the trace captured
 * that `AnalysisResponse` cannot give you (per-step timing, retry round, the
 * real SQL of every attempt, loop reasoning steps).
 *
 * Credentials are read from the environment only — never hardcode them:
 *   DEEPSEEK_API_KEY   (or AVA_LLM_API_KEY)  — required
 *   DEEPSEEK_BASE_URL  (default https://api.deepseek.com/v1)
 *   DEEPSEEK_MODEL     (default deepseek-chat)
 *
 * Run:
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/trace-deepseek.ts
 *   # or: npm run example:deepseek
 */
import { AVA } from '@antv/ava';

import { observe, ConsoleExporter, JsonExporter } from '../src';

import type { SpanRecord } from '../src/span';

const CSV = [
  'month,region,sales',
  '2025-01,East,1200',
  '2025-02,East,980',
  '2025-03,East,1430',
  '2025-01,West,760',
  '2025-02,West,1105',
  '2025-03,West,1340',
  '',
].join('\n');

/** Depth-first collect of every span in a root's tree. */
function flatten(span: SpanRecord, acc: SpanRecord[] = []): SpanRecord[] {
  acc.push(span);
  for (const child of span.children) flatten(child, acc);
  return acc;
}

function fmt(span: SpanRecord): string {
  return `${span.name}=${span.durationMs}ms${span.status === 'error' ? ' (error)' : ''}`;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.AVA_LLM_API_KEY;
  if (!apiKey) {
    console.error('Set DEEPSEEK_API_KEY (or AVA_LLM_API_KEY) in the environment; never hardcode it.');
    process.exit(2);
  }
  const baseURL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

  const ava = new AVA({ llm: { model, apiKey, baseURL, maxRetries: 1 } });

  // Console exporter prints the waterfall; JSON exporter lets us inspect attributes.
  const json = new JsonExporter();
  const handle = observe(ava, {
    exporter: [new ConsoleExporter(), json],
    serviceName: 'trace-deepseek',
  });

  await ava.source({ type: 'csv', options: { csv: CSV } });

  console.log('\n================ direct strategy ================');
  const direct = await ava.analyze('Compare total sales between the East and West regions', {
    strategy: { type: 'direct' },
  });
  console.log('\n[AnalysisResponse] what the return value gives you:');
  console.log(`  sql : ${direct.sql ?? '(none)'}`);
  console.log(`  rows: ${direct.data.length}`);
  console.log(`  text: ${direct.text.slice(0, 160)}`);

  console.log('\n================ loop strategy ==================');
  const loop = await ava.analyze('What is the total sales across all months?', {
    strategy: { type: 'loop', maxSteps: 3 },
  });
  console.log('\n[AnalysisResponse] what the return value gives you:');
  console.log(`  rows: ${loop.data.length}`);
  console.log(`  text: ${loop.text.slice(0, 160)}`);

  await handle.stop();
  await ava.dispose();

  // ---- what the trace adds beyond the return value ----
  console.log('\n================ what the trace adds ============');
  const [directRoot, loopRoot] = json.spans.filter((s) => s.name === 'analyze');

  if (directRoot) {
    console.log('\n[direct] per-step timing + captured process attributes:');
    for (const span of flatten(directRoot)) console.log(`  ${fmt(span)}`);
    const translate = directRoot.children.find((c) => c.name === 'translate');
    console.log(`  → translate attempt : ${translate?.attributes['ava.attempt']}`);
    console.log(`  → real SQL generated: ${String(translate?.attributes['ava.dsl'] ?? '').slice(0, 120)}`);
    const summarize = directRoot.children.find((c) => c.name === 'summarize');
    console.log(`  → summarize size    : ${summarize?.attributes['ava.summaryChars']} chars`);
  }

  if (loopRoot) {
    console.log('\n[loop] reasoning steps the return value never shows:');
    for (const span of flatten(loopRoot)) console.log(`  ${fmt(span)}`);
    for (const reason of loopRoot.children.filter((c) => c.name === 'reason')) {
      console.log(`  → step ${reason.attributes['ava.step']} chose action=${reason.attributes['ava.action']}`);
    }
  }

  console.log('\nDone. The waterfall above is the process; AnalysisResponse is only the outcome.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
