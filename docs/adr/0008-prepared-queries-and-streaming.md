# ADR 0008: Prepared queries are client-side plans; streaming uses cubrid-client's stream() with literal semantics, outside transactions

- **Status:** Accepted
- **Date:** 2026-11-18 (proposed)
- **Accepted:** 2026-11-20 by maintainer yeongseon, recorded in PR #260
- **Decision scope:** What `prepare()` and `iterator()` mean on `drizzle-cubrid/native`: selects, set operations, writes and relational queries; cursor, connection and transaction lifetime of a stream
- **Prerequisites:** [ADR 0003](0003-native-architecture-boundaries.md), [ADR 0007](0007-drizzle-extension-boundary.md), issue [#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)

## Context

Drizzle's dialects expose `prepare()` (build once, `execute(placeholderValues)` many times) and `iterator()` (rows one at a time). On MySQL and PostgreSQL drivers a prepared query can map to a server-side statement handle. cubrid-client 1.4.0, the only driver the native dialect supports (peer floor and lockfile), offers:

- `queryPrepared()` / `executePrepared()`: typed binds. Each call prepares, executes and closes its own server statement; there is no handle that outlives the call.
- `query()` / `execute()`: values written into the SQL text as escaped literals.
- `stream(sql, params, options)`: an async generator over an open server cursor with `rowMode: 'array'`, `signal`, `fetchSize` and `consumerTimeout`. Verified in `node_modules/cubrid-client/dist/index.js` (1.4.0): it renders `params` as **literals** (`literalOrRefuse`), sends nothing before the first read, holds one server reply (about 16 KiB of rows on CUBRID 10.2–11.4) at a time, and closes the cursor on `return()`/throw. On a pool it holds its lease from the first read until it ends. On a `CubridClient` it holds the shared connection: another statement on that client waits while the consumer reads and is refused with `kind: 'stream-busy'` after `consumerTimeout` (default 5000 ms) when the consumer stops reading.
- The transaction client that `transaction(callback)` passes in (`CallbackTransaction`) has **no `stream()`**, and neither does `beginTransactionScope()`'s handle.

Literals and typed binds do not always match the same rows. An independent review of the first implementation (a 480-case matrix comparing `execute()` with `iterator()` under both bindings, CUBRID 11.4.7) found, under the default `'prepared'` binding: `not(or(eq(t.c, placeholder), eq(t.id, 1)))` with a NULL (or `undefined`) value returned no row from `execute()` (typed `c = ?` with NULL is unknown) and every other row from a stream (a literal `c = NULL` inside `OR` is false), likewise for plain `eq(col, null)` and VARCHAR columns; `like(t.s, placeholder)` ignored trailing spaces with typed binds but not with literals (`'ab'` matched `'ab'` and `'ab  '`, against `'ab'` only; `''` matched `'  '` against `''`); and a denormal double (`5e-324`) is bound but its literal is a syntax error. Under `binding: 'literal'` both paths send literals and agreed.

Live on CUBRID 11.4.7 (`tests/integration.test.ts`, #165 block): a pool stream holds exactly one connection (`stats().active` 1 during, 0 after), `break`, a throw in the loop, `return()` and an abort each release it, and a server error such as division by zero (-539) is raised by the first read, before any row, because CUBRID evaluates the result when the statement runs.

## Decision

1. **`prepare()` is a client-side plan, never a server-side statement.** It renders the SQL text, keeps the parameters (with `sql.placeholder()`s in place), the row mapping and, for writes, the `$defaultFn()` values. Each `execute(placeholderValues)` fills the placeholders with Drizzle's `fillPlaceholders()` and sends the statement again through the session's binding (`queryPrepared`/`executePrepared` by default, `query`/`execute` under `binding: 'literal'`). The documentation says so explicitly.
2. **Same contract everywhere.** Selects, set operations, `insert`/`update`/`delete`, `$returningId()` and now relational `db.query.*.findMany()`/`findFirst()` have `prepare()`. A relational query's `prepare()` validates and plans the query once (options, relations, key types, callbacks); each execution builds and runs its statements as an awaited query does, in one transaction when it loads relations. Per-parent keys are values read from the parent rows, never placeholders. `limit` and `offset` may be placeholders there too (#236 refused them only because there was no `prepare()`); their values are checked as non-negative integers when executed.
3. **Placeholder values.** A placeholder without a value is refused before anything is sent (Drizzle's `No value for placeholder "x" was provided`). For a relational query this covers every level, so a nested level cannot fail after the root statement ran. Values no placeholder names are ignored, as in Drizzle (one values object may serve several queries). Values that are not an object are refused.
4. **`iterator(placeholderValues?, options?)`** on native selects, set operations and prepared selects, built on `stream()` with `rowMode: 'array'` and the same positional decoding as `execute()`. `options` are cubrid-client's `signal`, `fetchSize`, `consumerTimeout` (checked as cubrid-client checks them, when `iterator()` is called) and the dialect's `literal`; any other key is refused. A streamed statement is rendered as for `binding: 'literal'` (so #239's expansion of CHAR placeholder lists, which is for typed binds only, is not applied). Nothing is sent before the first read; leaving the loop early closes the cursor and releases the connection; errors are cubrid-client's, unchanged.
4a. **A stream never silently differs from `execute()`.** Under `binding: 'literal'`, `execute()` and `iterator()` both send literals and `iterator()` needs no option. Under `binding: 'prepared'` (the default), `iterator()` is refused before anything is sent, with an error that explains why and names the two ways out: create the database with `binding: 'literal'`, or pass `{ literal: true }` to that `iterator()` call to accept literal semantics for that stream. The documented differences (NULL inside `OR` under `NOT`, trailing spaces in `LIKE`, denormal doubles) are pinned by live tests of the opt-in. **Revisit** when cubrid-client can stream with typed binds (cubrid-lab/cubrid-client#307): `iterator()` should then use them under `'prepared'`, and the refusal and the opt-in go away (the opt-in keeping its literal meaning, or being deprecated, in a minor release).
5. **Refused, before anything is sent:** `iterator()` inside `db.transaction()` (no `stream()` on cubrid-client's transaction client; refused even for a custom client that has one, because savepoints and the callback's end have no defined interaction with an open cursor yet), on a client without `stream()`, and on relational queries (no row is complete before every level is loaded). The 0.x API keeps throwing from `iterator()`.

## Alternatives considered

- **Server-side reusable statements.** Not available in cubrid-client 1.4; emulating one would mean driving the CAS protocol directly, outside the driver boundary of ADR 0003.
- **Typed binds for streams.** Not possible with cubrid-client 1.4 `stream()` (requested in cubrid-lab/cubrid-client#307).
- **Stream with literals under `'prepared'` and only document it** (the first implementation). Rejected after review: a stream returned other rows than `execute()` of the same prepared query (above), with nothing at the call site showing it. Silent divergence of two methods of one query is worse than a refusal with a one-option way out.
- **Refuse without an opt-in.** Would leave the default binding with no streaming at all until #307; the per-call `literal: true` makes the choice visible where it is made.
- **Stream inside a transaction by buffering** (`queryPrepared()` and yield from memory): silently loses the bounded-memory contract. Rejected.
- **Refuse extra placeholder values.** Catches typos, but breaks Drizzle's sharing of one values object; a missing value is already refused.
- **Keep refusing relational `prepare()`.** Planning once is a real saving (relations, key types, callbacks) and gives placeholder `limit`/`offset` a meaning; kept refusal only for `iterator()`.

## Consequences and trade-offs

- A prepared query costs the same round trips as an awaited one; it saves only client-side building. Benchmarks must not claim server-side preparation.
- A stream on a `CubridClient` blocks that client's other statements until it ends; awaiting one inside the loop fails after `consumerTimeout`. Use a pool for streaming next to other work.
- A consumer that drives the iterator by hand and never calls `return()` keeps the connection (and the cursor) until the process ends; `for await` does not have that problem.
- Under the default binding, streaming needs either `binding: 'literal'` for the database (every statement then sends literals, one round trip fewer, and `execute()` and `iterator()` agree) or `{ literal: true }` per stream (which can return other rows than `execute()` in the documented cases). Code written with the opt-in keeps working when #307 lands.
- More streams open at once than a pool's `max`, read in lockstep, cannot all start: the extra first read rejects with `kind: 'pool-timeout'` after `acquireTimeoutMs`.
- A cubrid-client release adding `stream()` to transaction clients would let decision 5 be revisited; it needs its own tests for savepoints and for a callback that returns with a stream open.

## Verification / acceptance criteria

- [x] Unit tests with a fake client: SQL and parameters, literal rendering of streams, placeholder refusals before sending, option refusals, transaction refusal, lifecycle (`break`, throw, `return()`, decode error close the stream) — `tests/native/stream.test.ts`, `tests/native/relational.test.ts`, `tests/native/dml.test.ts`.
- [x] Type tests for `iterator()` row types and prepared `execute()` signatures — `tests/native/select.test-d.ts`, `dml.test-d.ts`, `relational.test-d.ts`.
- [x] Live CUBRID 11.4 tests, not skipped: `iterator()` refused under `'prepared'` with nothing sent; the opt-in's differences from `execute()` pinned; under `'literal'`, the same rows (or the same error) from `execute()`, a prepared `iterator()` and a direct `iterator()` over a matrix of 90+ conditions; prepared reuse under both bindings, prepared DML, 10,000 streamed rows with bigint/CHAR/DATETIME/SET codecs, pool release on early exit, concurrent streams, `stream-busy` on a client, transaction refusal and committed visibility, abort, server and decode errors, prepared relational queries.
- [x] Maintainer acceptance in a reviewed PR.

## References

- `src/native/session.ts` (`streamRows`), `src/native/select.ts` (`CubridPreparedSelect`), `src/native/relational.ts` (`CubridPreparedRelationalQuery`)
- [docs/NATIVE_API.md](../NATIVE_API.md#prepared-queries) and [#streaming](../NATIVE_API.md#streaming)
- cubrid-client 1.4.0 `StreamOptions`, `CubridPool.stream()`, `CubridClient.stream()`
