/**
 * Wire-level event names emitted by @antv/ava (see its src/event/constant.ts).
 * We subscribe with a single wildcard listener and dispatch on these strings,
 * so this package never depends on AVA internals or its exported enums.
 *
 * Version drift is real and handled by supporting the union of names:
 *  - published 4.0.0-beta.1 emits `load*` and has no `schema*` / `semantic*`;
 *  - current main renamed it to `source*` and added `schema*` / `semantic*`.
 * Unknown names are ignored (degrade, never crash), and `npm run verify` plus
 * the contract test re-check this list against the installed AVA.
 */
export const TOP_LEVEL_OPS = [
  'load',
  'source',
  'schema',
  'profile',
  'semantic',
  'analyze',
  'visualize',
  'suggest',
] as const;

/** Operations that nest inside a top-level operation (analysis steps + engine lifecycle). */
export const NESTED_OPS = ['create', 'dispose', 'selectcontext', 'translate', 'query', 'summarize', 'reason'] as const;

export type TopLevelOp = (typeof TOP_LEVEL_OPS)[number];
export type NestedOp = (typeof NESTED_OPS)[number];

export interface ParsedEvent {
  op: string;
  phase: 'start' | 'end';
  topLevel: boolean;
}

/**
 * Parse an event type like `analyzestart` / `queryend` into op + phase.
 * Returns null for unknown / malformed types so they are safely ignored.
 */
export function parseEvent(type: unknown): ParsedEvent | null {
  if (typeof type !== 'string') return null;

  let phase: ParsedEvent['phase'];
  let op: string;
  if (type.endsWith('start')) {
    phase = 'start';
    op = type.slice(0, -'start'.length);
  } else if (type.endsWith('end')) {
    phase = 'end';
    op = type.slice(0, -'end'.length);
  } else {
    return null;
  }

  const topLevel = (TOP_LEVEL_OPS as readonly string[]).includes(op);
  const nested = (NESTED_OPS as readonly string[]).includes(op);
  if (!topLevel && !nested) return null;

  return { op, phase, topLevel };
}
