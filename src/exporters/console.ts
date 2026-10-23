import type { Exporter, SpanRecord } from '../span';

const STATUS_MARK: Record<SpanRecord['status'], string> = {
  ok: '✓',
  error: '✗',
  unfinished: '…',
};

function summarizeAttributes(span: SpanRecord): string {
  const parts: string[] = [];
  const dsl = span.attributes['ava.dsl'];
  if (typeof dsl === 'string') parts.push(`dsl=${truncate(dsl.replace(/\s+/g, ' '), 60)}`);
  if (typeof span.attributes['ava.rows'] === 'number') parts.push(`rows=${span.attributes['ava.rows']}`);
  if (typeof span.attributes['ava.query'] === 'string')
    parts.push(`query=${truncate(String(span.attributes['ava.query']), 40)}`);
  if (span.attributes['ava.attribution'] === 'uncertain') parts.push('attribution=uncertain');
  return parts.length ? `  ${parts.join(' ')}` : '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function printSpan(span: SpanRecord, prefix: string, isLast: boolean, isRoot: boolean, lines: string[]): void {
  const connector = isRoot ? '' : isLast ? '└ ' : '├ ';
  const duration = span.durationMs === null ? 'open' : `${span.durationMs}ms`;
  lines.push(
    `${prefix}${connector}${STATUS_MARK[span.status]} ${span.name} (${duration})${summarizeAttributes(span)}`
  );

  const childPrefix = isRoot ? '' : `${prefix}${isLast ? '  ' : '│ '}`;
  span.children.forEach((child, index) => {
    printSpan(child, childPrefix, index === span.children.length - 1, false, lines);
  });
}

/**
 * Pretty-prints each completed trace as an indented waterfall. Zero
 * dependencies; intended for demos, local debugging, and tests.
 */
export class ConsoleExporter implements Exporter {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  exportSpan(span: SpanRecord): void {
    const lines: string[] = [];
    printSpan(span, '', true, true, lines);
    this.write(lines.join('\n'));
  }
}
