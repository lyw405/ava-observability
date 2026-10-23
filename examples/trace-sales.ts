/**
 * Real-AVA example: attach the observer and trace an analysis end to end.
 *
 * Requires @antv/ava and, for analyze/visualize, OPENAI_API_KEY.
 * Run: npx tsx examples/trace-sales.ts
 */
import { join } from 'node:path';

import { AVA } from '@antv/ava';

import { observe, ConsoleExporter } from '../src';

async function main(): Promise<void> {
  const ava = new AVA({
    llm: {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      baseURL: process.env.OPENAI_BASE_URL,
    },
  });

  // One line: everything below is traced.
  const handle = observe(ava, { exporter: new ConsoleExporter(), serviceName: 'ava-demo' });

  await ava.source({ type: 'csv-file', options: { path: join(__dirname, 'sample.csv') } });

  if (process.env.OPENAI_API_KEY) {
    await ava.analyze('Compare average income by region');
  } else {
    // No-key path still produces source/schema/profile/query spans.
    await ava.schema();
    await ava.profile({ metrics: ['row_count', 'null_count'] });
  }

  await handle.stop();
  await ava.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
