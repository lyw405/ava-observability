type Handler = (event: unknown) => void;

/**
 * Minimal stand-in for an AVA instance that reproduces the parts of
 * @antv/event-emitter the observer depends on: named listeners plus a `*`
 * wildcard listener, both receiving the `{ type, data }` event object, and
 * synchronous listener errors propagating to the emitter (like the real one).
 */
export class FakeAVA {
  private listeners = new Map<string, Set<Handler>>();

  on(type: string, handler: Handler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  off(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: string, data: unknown = {}): void {
    const event = { type, data };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    for (const handler of [...(this.listeners.get('*') ?? [])]) handler(event);
  }
}

/** Deterministic clock: `tick()` advances time by a fixed step. */
export function fakeClock(start = 1000, step = 10): { now: () => number; tick: () => number } {
  let current = start;
  return {
    now: () => current,
    tick: () => (current += step),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
