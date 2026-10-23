/**
 * Offline demo: replay a recorded AVA event stream and print the waterfall.
 * Requires no @antv/ava install and no API key.
 *
 * Run: npm run demo
 */
import { SpanBuilder, ConsoleExporter } from '../src';
import { fakeClock } from '../__tests__/helpers/fake-ava';
import fixture from '../__tests__/fixtures/direct-analyze.json';

const clock = fakeClock(0, 120); // 120ms per step so durations look realistic
const exporter = new ConsoleExporter();
const builder = new SpanBuilder({ now: clock.now, onRootComplete: (root) => exporter.exportSpan(root) });

for (const event of fixture as { type: string; data: unknown }[]) {
  builder.handle(event.type, event.data);
  clock.tick();
}
