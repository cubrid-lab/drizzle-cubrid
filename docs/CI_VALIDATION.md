# CI validation lanes

The repository separates developer-tool tests, published-package runtime compatibility, and real CUBRID database validation. This page describes what the current `.github/workflows/ci.yml` **actually checks**, not release capabilities that have not been implemented.

## Pull request checks

| Change type | CI work | What the result demonstrates |
| --- | --- | --- |
| Markdown/documentation-only PR | Diff classification, `git diff --check`, `CI gate` | Text and whitespace validation only; no package or database behavior was exercised |
| Source code, dependency, CI, toolchain or ambiguous PR | Biome lint and format check (`npm run lint`, Node 22, plus a misformatted-file probe that must fail), foreign-dialect boundary check on `src` and on the packed tarball (`scripts/check-dialect-boundary.mjs`), Node 20 and Node 22 typecheck/build/Vitest coverage, lowest supported `drizzle-orm` typecheck/build/Vitest (Node 22), live CUBRID 11.4 tests (`npm run integration`, no skipped tests allowed), CUBRID 11.4 fault-injection tests (`npm run integration:faults`, in a `docker run` container of their own, no skipped tests allowed), Node 22 npm packaging, the same live tests on the packed tarball installed in a clean consumer with the lockfile peers and with the peer floors (`scripts/packed-live.mjs`), Node 18 clean packed-package ESM/CJS consumer (plus a type check of the native binary column types with and without `@types/node`, `scripts/packed-types-check.mjs`), `CI gate` | Runtime and package compatibility with declared locked peers, and the behavior covered by the live CUBRID 11.4 tests |
| Push to `main` | Full runtime and packaging jobs | Ensures main does not rely on a docs-only shortcut |

Independent security workflows are not replaced by the docs-only classifier. A documentation-only PR does not disable any security policy or release preflight.

## Fixed Node.js support contract

`drizzle-cubrid@1.x` must retain the Node 18 minimum throughout the 1.x generation. We use newer Node 20/22 toolchains for Vitest and development dependencies, and a **separate Node 18 job** for the actual packed npm package. A clean Node 18 consumer uses the precise `drizzle-orm` and `cubrid-client` peer versions resolved in the candidate lockfile and checks both CommonJS `require()` and ESM `import()`, including creation of a representative table/collection column. A green Node 22 build alone is **not** Node 18 compatibility evidence.

## Coverage and database proof

The current Vitest configuration enforces **95%** for statements, branches, functions and lines. The threshold is not reduced or marked optional just to make CI pass. The Node 18 consumer job is separate from Vitest coverage.

The live suite (`tests/integration.test.ts`) runs against CUBRID 11.4 only and covers the behavior its test names describe (transactions, joins, write metadata, relational queries without `with` on the 0.x entry and with `with` on `drizzle-cubrid/native`, collections, binding modes, date and time columns, replacements for refused SQL). It also covers DDL inside a transaction (rollback, catalog visibility, autocommit) and the `drizzle-cubrid/native/migrator` applier ([ADR 0009](adr/0009-cubrid-native-migrations.md)). Unit and packaging jobs are not database evidence, and nothing in CI verifies other server versions, catalog reflection, schema diffing or `ALTER` generation. The fault-injection suite (`tests/faults.test.ts`) runs in its own job (`fault-cubrid`) because it restarts the database server and broker, pauses the container and kills CAS processes: a `services:` container would not survive that reliably, and the shared live suite must not be disturbed. The job starts the pinned CUBRID 11.4 image with `docker run`, passes its name as `CUBRID_TEST_CONTAINER`, and applies the same every-test-must-run-and-pass check (`scripts/check-live-results.mjs`); the tests fail rather than skip when `CUBRID_TEST_HOST`, `CUBRID_TEST_CONTAINER` or the Docker CLI is missing. Most faults are injected by an in-test TCP proxy (`tests/support/fault-proxy.ts`) that resets, stalls or refuses connections, or cuts a connection at a chosen CAS request such as COMMIT; Docker is used only where the server itself has to fail. It takes about a minute. The real-database test work is tracked in [issue #164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164), with its own actual versions, SQL assertions and nonzero test counts. The final release candidate must complete that verification before database behavior is advertised as supported.

## Release gate

`.github/workflows/publish.yml` runs on a `v*` tag. It checks that the tag matches `package.json`, builds and packs the tarball **once**, and then, against that tarball: the live suite on CUBRID 11.4 in a clean consumer project with the lockfile peers and with the peer floors (ESM suite plus a CommonJS smoke test of both entry points), and the Node 18 CJS/ESM consumer. Type check and unit tests (Node 20 and 22), lint and the foreign-dialect boundary run beside them. The publish job needs all of them; it checks the downloaded tarball's sha512 integrity against the packed one and the packed version against the tag, then runs `npm publish <tarball>`, so npm never packs the working tree again. Evidence (server version, image digest, versions, Git SHA, tarball integrity, test counts) is in the job summaries and the `release-live-evidence-*` artifacts. The docs-only shortcut does not exist in this workflow. See [What is verified](COMPATIBILITY.md#what-is-verified-and-what-is-not).

## Merge discipline

The `CI gate` fails if change classification is broken or if a **selected** job fails, is cancelled, is missing or is skipped. The docs-only route is limited to pull requests whose tracked changes are all documentation paths; changing a workflow, source code, dependency, `.nvmrc` or another unknown path runs the full validation. Registry publishing is gated as in [Release gate](#release-gate); supported database versions beyond CUBRID 11.4 require separate verification.
