# ava-observability

Zero-intrusion observability for [AVA](https://github.com/antvis/AVA): turn every data-analysis run into a standard span tree you can print as a waterfall in your terminal or collect as JSON today — with an `Exporter` interface sized for OpenTelemetry / Langfuse bridges (roadmap).

AVA's `analyze()` return value reports the **outcome** — the final SQL, the rows, the summary. It says nothing about the **process**: how long each step took, how many translation retries were burned, which intermediate SQL failed, how a `loop` run reasoned its way to an answer, or which step threw. This package listens to AVA's public event stream and reconstructs that process as a span tree.

```
✓ analyze (2400ms)  query=Compare Jan and Feb sales
├ ✓ translate (1200ms)  dsl=SELECT month, SUM(sales) FROM sales GROUP BY month
├ ✓ query (300ms)  rows=240
└ ✓ summarize (900ms)
```

## Why it exists

- Fills an official AVA **non-goal**: AVA deliberately leaves external runtime observability/exporters to the ecosystem (see AVA RFC #969).
- Answers the [AVA Ecosystem Integrations](https://github.com/antvis/AVA/issues/1035) call by connecting AVA to the observability tool ecosystem.
- **Zero intrusion**: it only subscribes to AVA's public `EventEmitter` wildcard (`ava.on('*', …)`); it never modifies AVA and adds no dependency to AVA core.

## Status & positioning

- **Independent community package**, not an official AVA module. It lives in its own repository and releases independently.
- It **consumes** the AVA roadmap deliverable 「标准运行事件」(standard runtime events, AVA v4 Runtime) and **exports** them to external observability platforms. It complements — and does not replace — the official first-party 「Runtime Trace 与关键运行指标」(internal evaluation/observability).
- Verified unclaimed: no observability/OTel/Langfuse exporter exists in AVA source, on npm, or in open AVA issues/PRs.

## Roadmap

- OpenTelemetry / Langfuse exporters (plug into the `Exporter` interface).
- Token usage via AVA's existing `llm.onQueryUsage` hook (two-step `createObserver` + `attach`), explicitly labeled `coverage=partial` until AVA extends the hook to summarize/visualize/suggest.
- Companion micro-PRs to AVA core: export event-name constants; complete `onQueryUsage` coverage.

## Install

```bash
npm install ava-observability
# peer: @antv/ava v4 beta
```

## Usage

```ts
import { AVA } from '@antv/ava';
import { observe, ConsoleExporter } from 'ava-observability';

const ava = new AVA({ llm: { model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! } });

// One line: everything after this is traced.
const handle = observe(ava, { exporter: new ConsoleExporter(), serviceName: 'my-app' });

await ava.source({ type: 'csv-file', options: { path: './sales.csv' } });
await ava.analyze('Compare January and February sales');

await handle.stop(); // unsubscribe + force-close + flush
```

### Exporters

- `ConsoleExporter` — pretty waterfall to stdout (default). Zero deps.
- `JsonExporter` — collects completed root spans in memory (`.spans`, `.toJSON()`); base for file/HTTP exporters.
- Bring your own: implement `{ exportSpan(span): void; flush?(): void }`. OpenTelemetry / Langfuse bridges plug in here (roadmap).

### Options

| option | meaning |
| --- | --- |
| `exporter` | one or more `Exporter`s (default `ConsoleExporter`) |
| `serviceName` | tagged on each root span as `service.name` |
| `sampleRate` | fraction `0..1` of traces to keep (default `1`) |
| `now` | injectable clock (tests) |

## Accuracy guarantees

Observability that lies is worse than none, so correctness is a first-class deliverable:

- **I1 no dangling spans** — every start is closed; abandoned spans are force-closed as `unfinished` on `stop()/flush()`.
- **I2 timing invariants** — every child interval lies inside its parent, links are consistent, and siblings are ordered by start time. Siblings *may* overlap (concurrent work and interleaved streams are legitimate); the non-overlap rule is asserted separately for genuinely sequential streams.
- **I3 uncertain attribution is flagged, never guessed** — overlapping roots or stray events get `ava.attribution=uncertain` instead of a wrong parent.
- **I4 observer never changes behavior** — the listener never throws into AVA; exporter failures are swallowed.
- **Differential cross-check** — tests compare span durations against an independently measured wall clock.
- **Record-replay golden fixture** — a recorded event stream replays to an exactly-asserted span tree.
- **Contract test against the installed AVA** — reads the event names from the installed `@antv/ava` build and fails if any name is unhandled, so a future AVA rename turns CI red instead of silently producing empty traces.
- **Real-stream goldens** — two streams recorded from actual AVA runs (one failure path, one live success path with a real LLM) replay to exactly-asserted span trees.

### Captured attributes

| attribute | from | meaning |
| --- | --- | --- |
| `ava.operation` | every span | operation name as emitted by AVA |
| `ava.query` | `analyze` / `translate` / `visualize` start | the user question |
| `ava.dsl` | `translate` end, `query` start | **the SQL the model actually generated** |
| `ava.rows` / `ava.rowCount` | `query` end | rows returned / total rows when known |
| `ava.truncated` / `ava.truncatedBy` | `query` end | result was bounded, and by which limit |
| `ava.summaryChars` | `summarize` end | size of the generated summary |
| `ava.attempt` | `translate` start | translation retry round (direct strategy) |
| `ava.step` / `ava.action` | `reason` start/end | loop reasoning step and chosen action |
| `ava.sourceType` | `load` / `source` start | data source type |
| `ava.attribution` | any span | `uncertain` when parentage could not be established |
| `service.name` | root spans | from the `serviceName` option |

Row **data is never captured** — only row counts — so traces are safe to store.

## Compatibility (verified against real AVA)

Verified end-to-end with the published **`@antv/ava@4.0.0-beta.1`** (`npm run verify`): a real csv load, profile, a failed analyze (unreachable LLM) and a standalone dispose produce exactly this tree —

```
✓ load (15ms)  ava.sourceType=csv
  ✓ create (0ms)
✓ profile (4ms)
✗ analyze (9ms)  ava.query=Compare income by region
  ✗ translate (9ms)  ava.attempt=0   exception: Cannot connect to API: bad port
✓ dispose (0ms)
```

**Event names drift between AVA versions, and this package handles the union:**

| | published `4.0.0-beta.1` | current `main` |
| --- | --- | --- |
| data loading | `load*` | renamed to `source*` |
| schema / semantic | not emitted | `schema*`, `semantic*` added |
| analysis steps | `translate* query* summarize* reason* selectcontext*` | same |
| engine lifecycle | `create* dispose*` | same |

Unknown event names are ignored (degrade, never crash). Payload fields used above were verified identical in both versions.

Documented granularity limits: the `analyze` root includes context prefetch (no separate child event); `visualize` is a leaf span (its internal chart-recommendation LLM call has no sub-events); token/cost attribution is out of scope for the MVP.

### Success path (real LLM, real DuckDB)

`npm run record` runs both analysis strategies against the published AVA with a live model and stores the stream as a golden fixture (`__tests__/fixtures/real-ava-analyze.json`, replayed in CI). This is what it produced:

```
✓ load (14ms)  ava.sourceType=csv
  ✓ create (0ms)
✓ analyze (2027ms)  ava.query=Compare sales in January and February
  ├ ✓ translate (781ms)  ava.attempt=0  ava.dsl=SELECT month, SUM(sales) … WHERE month IN ('January','February')
  ├ ✓ query (4ms)  ava.rows=0
  └ ✓ summarize (1241ms)  ava.summaryChars=348
✓ analyze (1942ms)  ava.query=What is the total sales across all months?
  ├ ✓ reason (648ms)  ava.step=0  ava.action=SQL
  ├ ✓ query (4ms)  ava.rows=1  ava.dsl=SELECT SUM(sales) AS total_sales FROM data;
  └ ✓ reason (1289ms)  ava.step=1  ava.action=CONFIRM
```

What this real run demonstrates (the first two are simply absent from `AnalysisResponse`; the third is refinement, not exclusive access):

- **Where the time goes** — the LLM took 2022ms of the 2027ms `analyze`; the SQL engine took 4ms. Optimising the database would have been wasted effort. The return value carries no timing at all.
- **How the answer was reached** — the `loop` run reasoned twice: `step=0 → SQL`, queried, then `step=1 → CONFIRM`. The return value only has the final `text`; the trace shows the verification loop and what each step cost.
- **Which step produced a bad plan** — the `direct` run wrote `'January'` literals against `2025-01` data. The empty result is also visible as `result.data.length === 0`, but the trace pins it to the `translate` step with the exact SQL and `ava.attempt`, and keeps the SQL of *every* retry when there are several.

## What the trace adds (and what it does not)

Stated plainly, so you can tell whether you need this layer:

| information | `AnalysisResponse` | trace |
| --- | :---: | :---: |
| final SQL | ✅ `sql` | ✅ |
| rows returned | ✅ `data.length` | ✅ |
| summary text | ✅ `text` | char count only |
| truncation / `rowCount` | ✅ | ✅ |
| per-step timing | ❌ | ✅ |
| translate retry round | ❌ | ✅ `ava.attempt` |
| intermediate / failed SQL | ❌ final only | ✅ every attempt |
| `loop` reasoning steps + actions | ❌ final text only | ✅ |
| which step threw | ❌ bare exception | ✅ localized span |
| cross-call correlation, history | ❌ ephemeral | ✅ one tree per root span |

**Rule of thumb:** if you only care about the result of one call sitting in front of you, `console.log(result)` is enough — do not add this layer. It pays off when you care about the **process** (tuning strategies and prompts), when you run **many** analyses (evaluation, batch, regression), or when you **cannot see** the return value at all (server-side, another user's session, an incident from last Tuesday).

## Boundaries (non-goals)

- Does not modify AVA core or add core dependencies.
- Not a result-inspection tool — see the comparison above. It is a *process* tracer.
- Exporters today are stdout and in-memory JSON; durable sinks (file / HTTP / OTLP) are roadmap, so long-term retention is not yet built in.
- No token/cost attribution yet. AVA already exposes an `llm.onQueryUsage` hook for SQL generation and loop reasoning, so real usage can be attached without core changes; coverage is partial until AVA also calls it in `summarize` / `visualize` / `suggest`.
- Single-instance sequential analysis assumed; concurrency is flagged `uncertain`, not mis-attributed.
- Traces only (no metrics/logs); no UI/dashboard — emit standard traces to existing platforms.

## Development

```bash
npm install
npm test        # 22 tests: builder, replay, contract (incl. real-stream goldens), accuracy (differential, fuzz, error paths)
npm run demo    # offline waterfall demo, no AVA / API key needed
npm run verify  # runs the REAL @antv/ava end-to-end and re-records the fixture (no API key needed)
npm run record  # re-records the real SUCCESS-path fixture; needs AVA_LLM_API_KEY (env only)
npm run typecheck
npm run build
```

Layout: `src/builder.ts` (event→span tree + invariants), `src/observe.ts` (subscription entry), `src/events.ts` (wire-name mapping), `src/exporters/*`, `__tests__/` (accuracy + contract suite), `scripts/verify-real-ava.ts` (real-AVA harness), `scripts/record-real-analyze.ts` (live success-path recorder), `examples/`.
