import { parseEvent } from './events';

import type { ParsedEvent } from './events';
import type { SpanRecord, SpanStatus } from './span';

export interface SpanBuilderOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Called once per completed root span (with its child tree). */
  onRootComplete?: (root: SpanRecord) => void;
}

interface Frame {
  record: SpanRecord;
  parent: Frame | null;
  openChildren: Frame[];
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasError(data: unknown): boolean {
  return isRecord(data) && data.error !== undefined && data.error !== null;
}

function errorMessage(data: unknown): string {
  const error = (data as Record<string, unknown>).error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function applyStartAttributes(record: SpanRecord, op: string, data: unknown): void {
  record.attributes['ava.operation'] = op;
  if (!isRecord(data)) return;

  if ((op === 'analyze' || op === 'translate' || op === 'visualize') && typeof data.query === 'string') {
    record.attributes['ava.query'] = data.query;
  }
  if (op === 'query' && typeof data.dsl === 'string') record.attributes['ava.dsl'] = data.dsl;
  // `load` (4.0.0-beta.1) and `source` (main) both carry the source type.
  if ((op === 'source' || op === 'load') && typeof data.type === 'string') {
    record.attributes['ava.sourceType'] = data.type;
  }
  // Translation retry round (direct strategy) and loop reasoning step.
  if (op === 'translate' && typeof data.attempt === 'number') record.attributes['ava.attempt'] = data.attempt;
  if (op === 'reason' && typeof data.step === 'number') record.attributes['ava.step'] = data.step;
}

function applyEndAttributes(record: SpanRecord, op: string, data: unknown): void {
  if (!isRecord(data)) return;

  if (op === 'translate' && typeof data.dsl === 'string') record.attributes['ava.dsl'] = data.dsl;

  if (op === 'query') {
    if (Array.isArray(data.data)) record.attributes['ava.rows'] = data.data.length;
    if (typeof data.rowCount === 'number') record.attributes['ava.rowCount'] = data.rowCount;
    if (data.truncated === true) {
      record.attributes['ava.truncated'] = true;
      if (typeof data.truncatedBy === 'string') record.attributes['ava.truncatedBy'] = data.truncatedBy;
    }
  }

  if (op === 'summarize' && typeof data.text === 'string') record.attributes['ava.summaryChars'] = data.text.length;
  if (op === 'reason') {
    if (typeof data.action === 'string') record.attributes['ava.action'] = data.action;
    if (typeof data.step === 'number') record.attributes['ava.step'] = data.step;
  }
}

/**
 * Builds a span tree from AVA's wildcard event stream.
 *
 * Accuracy invariants (see plan):
 *  - I1 every start is closed: unmatched/abandoned spans are force-closed as
 *    `unfinished` on flush/stop, never left dangling.
 *  - I3 uncertain attribution is flagged (`ava.attribution=uncertain`) instead
 *    of silently mis-parenting, e.g. overlapping roots or stray nested events.
 */
export class SpanBuilder {
  private readonly now: () => number;
  private readonly onRootComplete?: (root: SpanRecord) => void;
  private openRoots: Frame[] = [];

  constructor(options: SpanBuilderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onRootComplete = options.onRootComplete;
  }

  get openRootCount(): number {
    return this.openRoots.length;
  }

  /** Feed one wildcard event (`{ type, data }`) from AVA. */
  handle(type: unknown, data: unknown): void {
    const parsed = parseEvent(type);
    if (!parsed) return;
    if (parsed.phase === 'start') this.openSpan(parsed, data);
    else this.closeSpan(parsed, data);
  }

  /** I1: force-close everything still open and export the roots. */
  flush(): void {
    while (this.openRoots.length > 0) {
      const root = this.openRoots[this.openRoots.length - 1];
      this.openRoots.pop();
      this.closeFrame(root, undefined, this.now(), 'unfinished');
      this.completeRoot(root);
    }
  }

  private newFrame(op: string, time: number, parent: Frame | null): Frame {
    const spanId = nextId('span');
    const record: SpanRecord = {
      traceId: parent ? parent.record.traceId : spanId,
      spanId,
      parentSpanId: parent ? parent.record.spanId : null,
      name: op,
      operation: op,
      startTime: time,
      endTime: null,
      durationMs: null,
      status: 'ok',
      attributes: {},
      events: [],
      children: [],
    };
    return { record, parent, openChildren: [] };
  }

  private markUncertain(record: SpanRecord): void {
    record.attributes['ava.attribution'] = 'uncertain';
  }

  private openSpan(parsed: ParsedEvent, data: unknown): void {
    const time = this.now();

    if (parsed.topLevel) {
      // I3: a new root while another is open means overlapping work on one
      // instance; flag both rather than guessing a parent.
      if (this.openRoots.length > 0) this.markUncertain(this.openRoots[this.openRoots.length - 1].record);
      const frame = this.newFrame(parsed.op, time, null);
      if (this.openRoots.length > 0) this.markUncertain(frame.record);
      this.openRoots.push(frame);
      applyStartAttributes(frame.record, parsed.op, data);
      return;
    }

    const parent = this.innermostOpen();
    if (!parent) {
      // Stray nested event with no open frame. Engine lifecycle calls are
      // legitimately standalone (`ava.dispose()`), so they become plain roots;
      // an orphaned analysis step is kept but flagged (I3).
      const frame = this.newFrame(parsed.op, time, null);
      if (parsed.op !== 'create' && parsed.op !== 'dispose') this.markUncertain(frame.record);
      this.openRoots.push(frame);
      applyStartAttributes(frame.record, parsed.op, data);
      return;
    }

    const frame = this.newFrame(parsed.op, time, parent);
    parent.openChildren.push(frame);
    applyStartAttributes(frame.record, parsed.op, data);
  }

  /**
   * Deepest currently-open frame: nested operations nest inside each other
   * (e.g. the subset strategy runs `selectcontext` around translate/query/
   * summarize), so a new nested span belongs to the innermost open frame,
   * not always to the root.
   */
  private innermostOpen(): Frame | null {
    let frame = this.openRoots[this.openRoots.length - 1] ?? null;
    while (frame && frame.openChildren.length > 0) {
      frame = frame.openChildren[frame.openChildren.length - 1];
    }
    return frame;
  }

  /** Depth-first search for an open frame with this operation, innermost first. */
  private findInChildren(frame: Frame, op: string): Frame | null {
    for (let i = frame.openChildren.length - 1; i >= 0; i--) {
      const child = frame.openChildren[i];
      if (child.record.operation === op) return child;
      const deeper = this.findInChildren(child, op);
      if (deeper) return deeper;
    }
    return null;
  }

  private findOpen(op: string, topLevel: boolean): Frame | null {
    if (topLevel) {
      for (let i = this.openRoots.length - 1; i >= 0; i--) {
        if (this.openRoots[i].record.operation === op) return this.openRoots[i];
      }
      return null;
    }
    for (let i = this.openRoots.length - 1; i >= 0; i--) {
      const root = this.openRoots[i];
      if (root.record.operation === op) return root;
      const found = this.findInChildren(root, op);
      if (found) return found;
    }
    return null;
  }

  private closeSpan(parsed: ParsedEvent, data: unknown): void {
    const time = this.now();
    const target = this.findOpen(parsed.op, parsed.topLevel);
    if (!target) return; // unmatched end: ignore defensively

    const status: SpanStatus | undefined = hasError(data) ? 'error' : undefined;
    this.closeFrame(target, data, time, status);

    const isRoot = target.parent === null;
    if (isRoot) {
      this.openRoots = this.openRoots.filter((frame) => frame !== target);
      this.completeRoot(target);
    } else if (target.parent) {
      target.parent.openChildren = target.parent.openChildren.filter((frame) => frame !== target);
    }
  }

  private closeFrame(frame: Frame, data: unknown, time: number, forcedStatus?: SpanStatus): void {
    // Close any still-open children first so they land inside this span.
    while (frame.openChildren.length > 0) {
      const child = frame.openChildren.pop() as Frame;
      this.closeFrame(child, undefined, time, 'unfinished');
    }
    // Force-close closes children LIFO; keep the tree chronological so the
    // waterfall and the I2 sibling-order invariant hold.
    frame.record.children.sort((a, b) => a.startTime - b.startTime);

    const record = frame.record;
    applyEndAttributes(record, record.operation, data);
    record.endTime = time;
    record.durationMs = time - record.startTime;

    if (hasError(data)) {
      record.status = 'error';
      record.events.push({ name: 'exception', timestamp: time, attributes: { message: errorMessage(data) } });
    } else if (forcedStatus) {
      record.status = forcedStatus;
    } else {
      record.status = 'ok';
    }

    if (frame.parent) frame.parent.record.children.push(record);
  }

  private completeRoot(frame: Frame): void {
    this.onRootComplete?.(frame.record);
  }
}
