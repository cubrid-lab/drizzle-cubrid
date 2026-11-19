# Peer dependency compatibility

`drizzle-cubrid` declares these peer ranges in `package.json`:

| Peer | Declared range | Why this floor | Why this ceiling |
| --- | --- | --- | --- |
| `drizzle-orm` | `>=0.44.1 <0.46.0` | 0.44.0 and older fail to type-check (below) | 0.46 and the 1.0 release candidates are untested |
| `cubrid-client` | `>=1.4.0 <2.0.0` | the only version verified against a real CUBRID server (#185); `isolationLevel` also needs 1.3.0 or later | a 2.x driver may change its API |

A version outside these ranges is **unsupported**, even if it happens to install.
A version inside them is **verified** only where the tables below say so.

## drizzle-orm

Measured on 2026-11-13 (Node 24, tsup 9): install the version with
`npm install --no-save drizzle-orm@<version>`, then run `npx tsc --noEmit` and
`npx vitest run`. The first sweep (0.38.0 to 0.45.4) ran on the code before
#185; the rows marked † were rerun on the current code.

| Version | Type check | Unit tests | Status |
| --- | --- | --- | --- |
| 0.38.0, 0.39.0, 0.40.0, 0.41.0, 0.42.0 | fail: `drizzle-orm/cache/core/cache` does not exist; `MySqlPreparedQuery` takes no constructor arguments | 72 passed | unsupported |
| 0.43.1 † | fail, as above | 94 passed | unsupported |
| 0.44.0 † | fail: `MySqlPreparedQuery` requires a `Cache` argument | 94 passed | unsupported |
| 0.44.1 †, 0.44.3 † | pass | 94 passed | verified (0.44.1 is the floor checked in CI) |
| 0.44.2, 0.44.4 – 0.44.7, 0.45.0 | pass | 72 passed | verified |
| 0.45.4 † | pass | 94 passed | verified (lockfile version, CI and Node 18 consumer) |

The type check is the deciding column. The unit tests mock parts of
`drizzle-orm`, so they pass on versions the code cannot be compiled against,
and tsup 9 emits the bundle and declarations even when `tsc` reports errors.

CI checks both ends of the range on every code change:

- `lint-and-test` and the Node 18 packed-package consumer use the lockfile
  version (newest supported).
- `Lowest supported drizzle-orm` installs the floor taken from
  `peerDependencies` and runs the type check, build and tests.
- `Packed package on live CUBRID 11.4` runs the live suite on the packed
  tarball with the lockfile versions and with both peer floors taken from
  `peerDependencies`; the release gate in `publish.yml` runs it again on the
  tag's tarball.

### drizzle-orm internals this package depends on

Since 0.3 the root entry is the native dialect and the 0.x API is the
deprecated `drizzle-cubrid/legacy` entry, removed in 1.0
([ADR 0010](adr/0010-promote-native-root-deprecate-0x.md)). The 0.x API
extends Drizzle's MySQL classes, so it imports modules that are not
part of Drizzle's documented public API. These can change in any minor
release, which is why the ceiling is the next minor version:

- `drizzle-orm/mysql-core/session`: `MySqlSession`, `MySqlPreparedQuery`,
  `MySqlTransaction` (subclassed)
- `drizzle-orm/mysql-core/db`, `drizzle-orm/mysql-core/dialect`:
  `MySqlDatabase`, `MySqlDialect`
- `drizzle-orm/cache/core/cache`, `drizzle-orm/cache/core/types`: cache types
  passed to `MySqlPreparedQuery`
- `drizzle-orm/utils`: `mapResultRow`, which is not in the package's type
  declarations and is read through a cast

They go away with `drizzle-cubrid/legacy` in 1.0 (#155). The native root
entry, `drizzle-cubrid` (and its alias `drizzle-cubrid/native`,
[NATIVE_API.md](NATIVE_API.md)), imports only Drizzle's database-neutral modules (`column`, `column-builder`,
`entity`, `table`, `utils`) and reaches two internals through
`src/native/internal.ts`: the `Symbol.for('drizzle:Columns')` and
`Symbol.for('drizzle:ExtraConfigColumns')` table keys and
`ColumnBuilder#setName`, both checked on 0.44.1 and 0.45.4 (ADR 0007).

## cubrid-client

Measured the same way with `npm install --no-save cubrid-client@<version>`
(1.1.0 and 1.2.0 on the code before #185, the others on the current code):

| Version | Type check | Unit tests | Real CUBRID 11.4 | Status |
| --- | --- | --- | --- | --- |
| 1.0.0 – 1.2.0 | pass | 94 / 72 passed | not run | unsupported: `transaction()` takes no options; not verified against a server |
| 1.3.0 | pass | 94 passed | not run | unsupported: not verified against a server |
| 1.4.0 | pass | 94 passed | transaction isolation checks from #185 | verified |

Passing unit tests and a clean install are not database compatibility. The
live suite runs against a real server with both the lockfile version and the
floor (1.4.0, read from `peerDependencies`); see
[What is verified](#what-is-verified-and-what-is-not).

## Node.js

`engines.node` is `>=18`. The Node 18 job installs the packed tarball with the
lockfile's peer versions and imports it through CommonJS and ESM; see
[CI validation](CI_VALIDATION.md).

The package does not depend on `@types/node`. The value type of the native
`binary()` and `varbinary()` columns, `CubridBytes`, is Node's `Buffer` when
the consumer has Node's types and `Uint8Array` when it does not; the published
declarations never name `Buffer`, so they compile in both cases (#216).

## What is verified, and what is not

Every code change in CI (`.github/workflows/ci.yml`) and every release tag
before publishing (`.github/workflows/publish.yml`) runs these checks. A
release is published only if all of them pass, and what is published is the
tarball they tested.

| Check | Verified with |
| --- | --- |
| Live suite (`tests/integration.test.ts`) on the source | CUBRID 11.4 (`cubrid/cubrid:11.4`, pinned by digest), Node 22, `TZ=Asia/Seoul`, lockfile `drizzle-orm` and `cubrid-client` (CI only) |
| Live suite on the packed npm tarball, ESM: the native tests through `drizzle-cubrid` and `drizzle-cubrid/migrator` (the DDL helper through `drizzle-cubrid/native`), the 0.x tests through `drizzle-cubrid/legacy` | The same server and Node; once with the lockfile peers (`drizzle-orm` 0.45.4, `cubrid-client` 1.4.0) and once with the peer floors from `package.json` (`drizzle-orm` 0.44.1, `cubrid-client` 1.4.0) |
| CommonJS live smoke on the packed tarball | `require('drizzle-cubrid')`, `require('drizzle-cubrid/native')` (asserted to be the same module) and `require('drizzle-cubrid/legacy')` against the same server, in both peer lanes: generated keys, BIGINT beyond 2^53, SET values, rollback and error propagation |
| Packed tarball imported on Node 18 | CommonJS and ESM, every entry point: `drizzle-cubrid` and `drizzle-cubrid/native` are the same module (and the same classes), `drizzle-cubrid/migrator` and `drizzle-cubrid/native/migrator` the same module (it reads a migrations folder), `drizzle-cubrid/legacy` works and emits its `DRIZZLE_CUBRID_LEGACY` deprecation warning exactly once (silenced by `--no-deprecation`, thrown by `--throw-deprecation`, never by the root); lockfile peers, no database |
| Packed `.d.ts` on Node 18 | TypeScript 5.9 with `nodenext`: binary column types with and without `@types/node`; root and `/native` types are identical, a removed 0.x name does not compile when called from the root, `drizzle-cubrid/legacy` still type-checks (`scripts/packed-types-check.mjs`) |
| Type check, build and unit tests | Node 20 and 22 with the lockfile peers; Node 22 with the `drizzle-orm` floor |
| Lint and the foreign-dialect boundary | `src` and the packed tarball |
| Fault injection (`tests/faults.test.ts`, `npm run integration:faults`) on the source | CUBRID 11.4 (same pinned digest) in a container of its own that the tests restart, pause and kill, Node 22, lockfile peers (CI only, not in the release gate) |

**Fault scenarios verified** (CUBRID 11.4, cubrid-client 1.4.0, mostly
the native API; each test checks the persisted rows through a new
connection and that the pool recovers; what callers see is in
[Failures](NATIVE_API.md#failures)):

- A connection lost in a transaction (socket reset between statements, the
  reply of a statement lost, every CAS process killed with `kill -9`, a
  database server restart): rejects, commits nothing. Also through a single
  `CubridClient` and through the 0.x API (lost connection).
- A database server restart and a broker restart between queries on a pool,
  and a server that refuses connections: the next query succeeds, or fails at
  once with `kind: 'connection-lost'` while the server is unreachable.
- A connection lost during COMMIT, before the COMMIT reached the server and
  after (reply lost), for `db.transaction()`, for the 0.x API (reply lost)
  and for an autocommit write: the driver's error is passed through unchanged
  with `outcomeUnknown: true`, and the real outcome (not committed / committed)
  is checked.
- Lock timeout in a transaction and in a nested transaction, a deadlock
  between two transactions and with a nested transaction as the victim, and
  a lock wait longer than `readTimeout`.
- A network stall with and without `readTimeout`, and the server container
  paused with `docker pause`.
- A relational query with `with` whose connection is lost between the root
  and the child statement.

**Prepared queries and streaming verified** (CUBRID 11.4, cubrid-client
1.4.0, the native API, in the live suite; see
[Prepared queries](NATIVE_API.md#prepared-queries) and
[Streaming](NATIVE_API.md#streaming)):

- A prepared select re-run with different placeholder values (`limit`
  included) under both bindings, prepared inserts with `$returningId()`,
  updates and deletes, and prepared relational queries with placeholder
  `where`, `limit` and `offset` at the root and a nested level; a missing
  value is refused before any statement.
- `iterator()` refused under the default `binding: 'prepared'` with no
  statement sent; with `{ literal: true }`, the documented differences from
  `execute()` (a NULL inside `OR` under `NOT`, trailing spaces in `LIKE`)
  pinned.
- Under `binding: 'literal'`: the same rows, or the same error, from
  `execute()`, a prepared `iterator()` and a direct `iterator()` over a
  matrix of 90+ conditions (quoted, escaped, Unicode and blank strings,
  NULL/`undefined` placeholders under `NOT`/`OR`, CHAR `IN` lists, BIGINT
  extremes, doubles, dates); 10,000 streamed rows on one pool connection,
  each equal to what `execute()` returns (BIGINT beyond 2^53, CHAR padding,
  DATETIME, SET); a set operation.
- The pool connection released (`stats().active` back to 0) after `break`,
  a throw in the loop, `return()` and an `AbortSignal`; three interleaved
  streams on three connections; a third stream on a pool of `max: 2`
  rejected with `kind: 'pool-timeout'`; a statement awaited inside the loop refused
  with `kind: 'stream-busy'` on a `CubridClient` and run on another
  connection of a pool; a server error at the first read and a decode error
  mid-stream releasing the connection; `iterator()` refused inside
  `db.transaction()` while a stream outside it reads only committed rows.

A live lane passes only if it ran a non-zero number of tests and none failed or
was skipped (`scripts/check-live-results.mjs`), and the server's `version()`
starts with `11.4`. Each packed lane records the server version, image digest,
Node, `drizzle-orm`, `cubrid-client`, package version, Git SHA, tarball sha512
and integrity, and test counts in the job summary and in an uploaded evidence
artifact (`scripts/packed-live.mjs`). On a tag, the publish job checks that the
tarball's integrity equals the one packed and its version equals the tag,
then runs `npm publish <tarball>`.

**Not verified:**

- CUBRID server versions other than 11.4 (10.2, 11.0, 11.2 and later
  releases): no test runs against them.
- `cubrid-client` versions between the floor and the lockfile version other
  than those two (today they are the same, 1.4.0), and `drizzle-orm` versions
  other than 0.44.1 and 0.45.4 against a live server (the type-check sweep
  above is offline).
- Node 18 and Node 20 against a live server (Node 18 only imports the
  package), and Node 24 or later.
- Fault scenarios other than those listed above: HA failover and
  replication, a server crash during recovery, broken TLS sessions, killing a
  transaction with `cubrid killtran`, the 0.x API beyond a lost connection
  and a lost COMMIT reply, and fault behavior with any other server or
  `cubrid-client` version.
- Windows and macOS: every job runs on Linux (`ubuntu-latest`).
- A TypeScript consumer of the packed `.d.ts` files beyond the cases of `scripts/packed-types-check.mjs` (other `moduleResolution` settings, `skipLibCheck: false`, TypeScript versions other than 5.9).
- Schema reflection, schema diffing and `ALTER` generation (#163). The migrator ([MIGRATIONS.md](MIGRATIONS.md)) is live-tested on CUBRID 11.4 only, for the DDL kinds [ADR 0009](adr/0009-cubrid-native-migrations.md) lists. Indexes and foreign keys generated from native tables (#157) are live-tested on CUBRID 11.4 only; descending, function-based and filtered indexes are not generated.
- Streaming memory use beyond the row count: the bound of one server reply
  is cubrid-client's contract (`stream()`), not measured by these tests.
